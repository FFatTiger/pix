/**
 * Reference harness — wires the in-memory reference fake into the contract
 * suite and provides all optional ports so the full suite runs for real.
 */
import type { AgentRuntimeFactory } from "@fffattiger/pix-runtime-core";
import type { AdapterContractHarness, AdapterPortBundle, HarnessFactoryOptions } from "./harness.js";
import { ReferenceRuntimeFactory } from "./fake/factory.js";
import {
  ReferenceCredentialStore,
  ReferenceModelCatalog,
  ReferenceProjectTrust,
  ReferenceProjectTrustMutation,
  ReferenceResourceCatalog,
  ReferenceSessionCatalog,
  ReferenceSessionLocator,
  ReferenceTrustDecisions,
} from "./fake/ports.js";

export { ReferenceRuntimeFactory } from "./fake/factory.js";
export {
  ReferenceAgentRuntime,
  KNOWN_TOOLS,
  THINKING_LEVELS,
} from "./fake/runtime.js";
export { ReferenceSessionStore } from "./fake/store.js";
export {
  ReferenceCredentialStore,
  ReferenceModelCatalog,
  ReferenceProjectTrust,
  ReferenceProjectTrustMutation,
  ReferenceResourceCatalog,
  ReferenceSessionCatalog,
  ReferenceSessionLocator,
  ReferenceTrustDecisions,
} from "./fake/ports.js";

export function createReferenceHarness(options?: { baseDir?: string }): AdapterContractHarness {
  const factories = new Set<ReferenceRuntimeFactory>();

  return {
    async createFactory(factoryOptions?: HarnessFactoryOptions): Promise<AgentRuntimeFactory> {
      const factory = new ReferenceRuntimeFactory({
        ...factoryOptions,
        ...(options?.baseDir === undefined ? {} : { baseDir: options.baseDir }),
      });
      factories.add(factory);
      return factory;
    },

    async createPorts(factory: AgentRuntimeFactory): Promise<AdapterPortBundle> {
      const reference = factory as ReferenceRuntimeFactory;
      // One shared decision store: the mutation port's writes are immediately
      // visible to the query port (the persisted-decision model).
      const decisions = new ReferenceTrustDecisions();
      return {
        sessionCatalog: new ReferenceSessionCatalog(reference.store),
        sessionLocator: new ReferenceSessionLocator(reference.store),
        modelCatalog: new ReferenceModelCatalog(),
        credentialStore: new ReferenceCredentialStore(),
        resourceCatalog: new ReferenceResourceCatalog(),
        projectTrust: new ReferenceProjectTrust(decisions),
        projectTrustMutation: new ReferenceProjectTrustMutation(decisions),
      };
    },

    async getSideChatSnapshot(sessionId: string) {
      for (const factory of factories) {
        const snapshot = factory.store.buildSideChatSnapshot(sessionId);
        if (snapshot) return snapshot;
      }
      return null;
    },

    async teardown() {
      factories.clear();
    },
  };
}
