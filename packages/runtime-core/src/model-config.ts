/**
 * Canonical editable models.json projection.
 *
 * This surface is deliberately credential-blind: persisted API-key material is
 * represented only by `apiKeyConfigured`; mutations carry a one-way secret
 * operation. Opaque Pi-only fields (headers, compat extensions, sampling
 * parameters, modelOverrides, etc.) stay inside the adapter and are preserved
 * during a compare-and-swap update.
 */

/** Pi API adapter id. Extensible: unknown future ids must round-trip losslessly. */
export type ModelConfigApi = string;

export interface ModelConfigCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface EditableModelConfig {
  /** Stable source index for lossless merging; null marks a newly added row. */
  sourceIndex: number | null;
  id: string;
  name?: string;
  api?: ModelConfigApi;
  reasoning?: boolean;
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelConfigCost;
}

export interface EditableProviderConfig {
  /** Original provider id for rename-safe hidden-field preservation. */
  sourceId: string | null;
  id: string;
  baseUrl?: string;
  api?: ModelConfigApi;
  /** True when the persisted provider has an API-key expression or literal. */
  apiKeyConfigured: boolean;
  /** Whether `models` existed in the source config (undefined vs [] matters). */
  modelsDefined: boolean;
  models: readonly EditableModelConfig[];
}

export interface AvailableModelProvider {
  id: string;
  name: string;
  methods: readonly ("oauth" | "apiKey")[];
  modelCount: number;
}

export interface ModelsConfigSnapshot {
  /** SHA-256 of the exact source bytes; used as the optimistic revision fence. */
  revision: string;
  providers: readonly EditableProviderConfig[];
  availableProviders: readonly AvailableModelProvider[];
}

export type ModelConfigApiKeyMutation =
  | { mode: "preserve" }
  | { mode: "remove" }
  | { mode: "replace"; value: string };

export interface ModelConfigProviderMutation extends Omit<EditableProviderConfig, "apiKeyConfigured"> {
  apiKey: ModelConfigApiKeyMutation;
}

export interface ModelsConfigMutation {
  expectedRevision: string;
  providers: readonly ModelConfigProviderMutation[];
}

export interface ModelDiscoveryInput {
  expectedRevision: string;
  sourceId: string | null;
  providerId: string;
  baseUrl: string;
  api: ModelConfigApi;
  /** Optional newly typed key; persisted keys are resolved server-side. */
  apiKey?: string;
}

export interface DiscoveredModelConfig {
  id: string;
  name?: string;
}

/** Writable models.json authority. Reads never return credential material. */
export interface ModelConfigStorePort {
  readConfig(): Promise<ModelsConfigSnapshot>;
  writeConfig(input: ModelsConfigMutation): Promise<ModelsConfigSnapshot>;
  discoverModels(input: ModelDiscoveryInput): Promise<readonly DiscoveredModelConfig[]>;
}
