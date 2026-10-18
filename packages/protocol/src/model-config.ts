import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/** Extensible Pi API adapter id; future ids must round-trip without data loss. */
export const ModelConfigApiSchema = NonEmptyStringSchema;
export type ModelConfigApi = z.infer<typeof ModelConfigApiSchema>;

export const ModelConfigCostSchema = z.strictObject({
  input: z.number().finite().nonnegative().optional(),
  output: z.number().finite().nonnegative().optional(),
  cacheRead: z.number().finite().nonnegative().optional(),
  cacheWrite: z.number().finite().nonnegative().optional(),
});

export const EditableModelConfigSchema = z.strictObject({
  sourceIndex: z.number().int().nonnegative().safe().nullable(),
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema.optional(),
  api: ModelConfigApiSchema.optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
  cost: ModelConfigCostSchema.optional(),
  /**
   * Picker-visibility snapshot flag (settings.json `enabledModels` scope).
   * Read projections always carry it; mutation models never do — visibility
   * changes go through the settings model-visibility seam.
   */
  visibleInPicker: z.boolean().optional(),
});
export type EditableModelConfig = z.infer<typeof EditableModelConfigSchema>;

/** Snapshot model row: the read projection always carries picker visibility. */
export const CatalogModelConfigSchema = EditableModelConfigSchema.extend({
  visibleInPicker: z.boolean(),
});
export type CatalogModelConfig = z.infer<typeof CatalogModelConfigSchema>;

export const EditableProviderConfigSchema = z.strictObject({
  sourceId: NonEmptyStringSchema.nullable(),
  id: NonEmptyStringSchema,
  baseUrl: NonEmptyStringSchema.optional(),
  api: ModelConfigApiSchema.optional(),
  apiKeyConfigured: z.boolean(),
  modelsDefined: z.boolean(),
  models: z.array(EditableModelConfigSchema),
});
export type EditableProviderConfig = z.infer<typeof EditableProviderConfigSchema>;

/** Snapshot provider row: model rows always carry `visibleInPicker`. */
export const CatalogProviderConfigSchema = EditableProviderConfigSchema.extend({
  models: z.array(CatalogModelConfigSchema),
});
export type CatalogProviderConfig = z.infer<typeof CatalogProviderConfigSchema>;

export const AvailableModelProviderSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  methods: z.array(z.enum(["oauth", "apiKey"])),
  modelCount: z.number().int().nonnegative().safe(),
});
export type AvailableModelProvider = z.infer<typeof AvailableModelProviderSchema>;

export const ModelsConfigResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  providers: z.array(CatalogProviderConfigSchema),
  availableProviders: z.array(AvailableModelProviderSchema),
});
export type ModelsConfigResponse = z.infer<typeof ModelsConfigResponseSchema>;

export const ModelConfigApiKeyMutationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("preserve") }),
  z.strictObject({ mode: z.literal("remove") }),
  z.strictObject({ mode: z.literal("replace"), value: NonEmptyStringSchema }),
]);
export type ModelConfigApiKeyMutation = z.infer<typeof ModelConfigApiKeyMutationSchema>;

export const ModelConfigProviderMutationSchema = EditableProviderConfigSchema.omit({
  apiKeyConfigured: true,
}).extend({
  apiKey: ModelConfigApiKeyMutationSchema,
  // Mutations never carry the snapshot-only visibility flag.
  models: z.array(EditableModelConfigSchema.omit({ visibleInPicker: true })),
});
export type ModelConfigProviderMutation = z.infer<typeof ModelConfigProviderMutationSchema>;

export const ModelsConfigMutationSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  providers: z.array(ModelConfigProviderMutationSchema),
});
export type ModelsConfigMutation = z.infer<typeof ModelsConfigMutationSchema>;

export const ModelDiscoveryInputSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  sourceId: NonEmptyStringSchema.nullable(),
  providerId: NonEmptyStringSchema,
  /**
   * Provider endpoint to probe. Absent/blank means "use this Pi built-in
   * provider's default endpoint" (the adapter resolves it from the SDK
   * catalog); a non-built-in provider must supply one and the adapter rejects
   * a missing endpoint with `invalid_input`.
   */
  baseUrl: NonEmptyStringSchema.optional(),
  /** API type; absent means the built-in provider's own default api. */
  api: ModelConfigApiSchema.optional(),
  apiKey: NonEmptyStringSchema.optional(),
});
export type ModelDiscoveryInput = z.infer<typeof ModelDiscoveryInputSchema>;

/**
 * Parameter block a public catalog (models.dev) contributed for a model id.
 * Mirrors runtime-core `ModelMetadataFields`; only positive known values are
 * ever emitted by the Host, and absence of every field is legal (unknown).
 */
export const ModelMetadataFieldsSchema = z.strictObject({
  name: NonEmptyStringSchema.optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
  cost: ModelConfigCostSchema.optional(),
});
export type ModelMetadataFields = z.infer<typeof ModelMetadataFieldsSchema>;

export const DiscoveredModelConfigSchema = ModelMetadataFieldsSchema.extend({
  id: NonEmptyStringSchema,
  /** Catalog that supplied the parameters; null/absent when nothing matched. */
  metadataSource: z.literal("models.dev").nullable().optional(),
});
export type DiscoveredModelConfig = z.infer<typeof DiscoveredModelConfigSchema>;

export const ModelDiscoveryResponseSchema = z.strictObject({
  models: z.array(DiscoveredModelConfigSchema),
});
export type ModelDiscoveryResponse = z.infer<typeof ModelDiscoveryResponseSchema>;

/** Max ids per models.dev parameter lookup (bounded Host request surface). */
export const MODEL_METADATA_MAX_IDS = 100;

export const ModelMetadataRequestSchema = z.strictObject({
  ids: z.array(NonEmptyStringSchema).min(1).max(MODEL_METADATA_MAX_IDS),
  api: ModelConfigApiSchema,
});
export type ModelMetadataRequest = z.infer<typeof ModelMetadataRequestSchema>;

/** Lookup result: per requested id, matched parameters or null (no match). */
export const ModelMetadataResponseSchema = z.strictObject({
  metadata: z.record(z.string(), ModelMetadataFieldsSchema.nullable()),
});
export type ModelMetadataResponse = z.infer<typeof ModelMetadataResponseSchema>;
