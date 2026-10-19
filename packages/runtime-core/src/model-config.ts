import type { ThinkingLevel } from "./messages.js";

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

/**
 * Per-level thinking mapping (models.json `thinkingLevelMap`): the string sent
 * to the provider for a Pi thinking level, or `null` for a level the model
 * does not support. The level vocabulary is the canonical `THINKING_LEVELS`
 * list (runtime-core `messages.ts`); `xhigh`/`max` are only selectable for a
 * model that maps them.
 */
export type ModelThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

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
  /**
   * Per-level thinking mapping (models.json `thinkingLevelMap`): the string
   * sent to the provider for each Pi thinking level, `null` for a level the
   * model does not support. `xhigh`/`max` are only selectable when mapped.
   */
  thinkingLevelMap?: ModelThinkingLevelMap;
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelConfigCost;
  /**
   * Snapshot-only picker-visibility flag: whether this model is visible in
   * the model picker under the current global `enabledModels` scope
   * (settings.json). Read projections always set it; mutations never carry
   * it — visibility changes go through the settings model-visibility seam.
   */
  visibleInPicker?: boolean;
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
  /**
   * Endpoint to probe. Omitted for a Pi built-in provider: the adapter resolves
   * that provider's own default Base URL from the SDK catalog. A provider that
   * is not built in must supply one (`invalid_input` otherwise).
   */
  baseUrl?: string;
  /** Explicit api type; omitted means the built-in provider's own default. */
  api?: ModelConfigApi;
  /** Optional newly typed key; persisted keys are resolved server-side. */
  apiKey?: string;
}

/**
 * Parameters a public catalog (models.dev) can contribute for a model id.
 * Only fields with a positive known value are present; absence means unknown.
 */
export interface ModelMetadataFields {
  name?: string;
  reasoning?: boolean;
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelConfigCost;
}

export interface DiscoveredModelConfig extends ModelMetadataFields {
  id: string;
  /** Which catalog supplied the parameters; null when nothing matched. */
  metadataSource: "models.dev" | null;
}

export interface ModelMetadataLookupInput {
  /** Model ids to look up (non-empty, bounded by the wire contract). */
  ids: readonly string[];
  /** Requester's API type; biases multi-provider candidate preference. */
  api: ModelConfigApi;
}

export interface ModelMetadataEntry {
  id: string;
  /** Matched parameters, or null when no catalog entry matched. */
  metadata: ModelMetadataFields | null;
}

/** Writable models.json authority. Reads never return credential material. */
export interface ModelConfigStorePort {
  readConfig(): Promise<ModelsConfigSnapshot>;
  writeConfig(input: ModelsConfigMutation): Promise<ModelsConfigSnapshot>;
  discoverModels(input: ModelDiscoveryInput): Promise<readonly DiscoveredModelConfig[]>;
  /** Parameter lookup against the public models.dev catalog (never throws per id). */
  resolveModelMetadata(input: ModelMetadataLookupInput): Promise<readonly ModelMetadataEntry[]>;
}
