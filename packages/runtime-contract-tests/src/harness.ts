/**
 * Harness contract for the reusable adapter contract suite.
 *
 * An adapter implementation (or the reference fake) supplies a harness that
 * knows how to create isolated factories; the suite then runs the canonical
 * behavior matrix against any conforming implementation.
 */
import type {
  AgentRuntimeFactory,
  CredentialStorePort,
  ModelCatalogPort,
  ModelSelector,
  ProjectTrustPort,
  ResourceCatalogPort,
  RuntimeCapability,
  SessionCatalogPort,
  SessionLocatorPort,
  SideChatMainSnapshot,
} from "@fffattiger/pi-web-runtime-core";

export interface HarnessFactoryOptions {
  /** Restrict the capability set reported by created runtimes. */
  capabilities?: readonly RuntimeCapability[];
  /** Working directory used for created sessions. */
  cwd?: string;
  /** Initial model selection. */
  model?: ModelSelector;
  /** Capability set reported after a `reload` command. */
  reloadCapabilities?: readonly RuntimeCapability[];
}

export interface AdapterPortBundle {
  sessionCatalog: SessionCatalogPort;
  sessionLocator: SessionLocatorPort;
  modelCatalog: ModelCatalogPort;
  credentialStore: CredentialStorePort;
  resourceCatalog: ResourceCatalogPort;
  projectTrust: ProjectTrustPort;
}

export interface AdapterContractHarness {
  /**
   * Create a fresh, isolated factory. Each test receives its own factory so
   * implementations must isolate sessions per factory.
   */
  createFactory(options?: HarnessFactoryOptions): Promise<AgentRuntimeFactory>;

  /**
   * Ports sharing the same backend as `factory`. ACL0/ACL1 adapters are
   * required to provide the complete bundle; absence is a contract failure.
   */
  createPorts(factory: AgentRuntimeFactory): Promise<AdapterPortBundle>;

  /** Optional: build the side-chat main-snapshot DTO for a session. */
  getSideChatSnapshot?(sessionId: string): Promise<SideChatMainSnapshot | null>;

  /** Clean up global state after the run. */
  teardown(): Promise<void>;
}
