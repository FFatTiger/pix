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
});
export type EditableModelConfig = z.infer<typeof EditableModelConfigSchema>;

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

export const AvailableModelProviderSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  methods: z.array(z.enum(["oauth", "apiKey"])),
  modelCount: z.number().int().nonnegative().safe(),
});
export type AvailableModelProvider = z.infer<typeof AvailableModelProviderSchema>;

export const ModelsConfigResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  providers: z.array(EditableProviderConfigSchema),
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
  baseUrl: NonEmptyStringSchema,
  api: ModelConfigApiSchema,
  apiKey: NonEmptyStringSchema.optional(),
});
export type ModelDiscoveryInput = z.infer<typeof ModelDiscoveryInputSchema>;

export const DiscoveredModelConfigSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema.optional(),
});
export type DiscoveredModelConfig = z.infer<typeof DiscoveredModelConfigSchema>;

export const ModelDiscoveryResponseSchema = z.strictObject({
  models: z.array(DiscoveredModelConfigSchema),
});
export type ModelDiscoveryResponse = z.infer<typeof ModelDiscoveryResponseSchema>;
