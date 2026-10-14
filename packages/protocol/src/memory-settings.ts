import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/**
 * Wire projection of the long-term memory settings (settings.json
 * `pixMemoryProvider` + the Lore connection facts).
 *
 * Canonical owner is `packages/runtime-core/src/settings-config.ts`
 * (`MemoryProvider` / `LoreConnectionSnapshot`); Protocol cannot import
 * runtime-core (architecture rule 7), so this module mirrors the shapes and
 * cross-package contract tests pin the two copies. The API token is
 * WRITE-ONLY: no response schema in this module ever carries it.
 */

/** Default Loremem SaaS base URL (self-host users replace it). */
export const LORE_SAAS_BASE_URL = "https://api.loremem.com";

export const MemoryProviderSchema = z.enum(["local", "lore", "off"]);
export type MemoryProviderWire = z.infer<typeof MemoryProviderSchema>;
export const MEMORY_PROVIDERS = MemoryProviderSchema.options;

export const LoreConnectionSchema = z.strictObject({
  configured: z.boolean(),
  baseUrl: z.string().nullable(),
  source: z.enum(["config", "env", "none"]),
  tokenConfigured: z.boolean(),
});
export type LoreConnectionWire = z.infer<typeof LoreConnectionSchema>;

export const MemorySettingsResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  provider: MemoryProviderSchema,
  providerExplicit: z.boolean(),
  lore: LoreConnectionSchema,
});
export type MemorySettingsResponse = z.infer<typeof MemorySettingsResponseSchema>;

export const MemoryProviderMutationSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  provider: MemoryProviderSchema,
});
export type MemoryProviderMutation = z.infer<typeof MemoryProviderMutationSchema>;

/** Token semantics mirror @loremem/cli: keep when the URL is unchanged. */
export const LoreConnectionMutationSchema = z.strictObject({
  baseUrl: NonEmptyStringSchema,
  apiToken: z.string().min(1).max(4096).optional(),
});
export type LoreConnectionMutation = z.infer<typeof LoreConnectionMutationSchema>;

export const LoreTestRequestSchema = z.strictObject({
  baseUrl: z.string().min(1).max(2048).optional(),
  apiToken: z.string().min(1).max(4096).optional(),
});
export type LoreTestRequest = z.infer<typeof LoreTestRequestSchema>;

/**
 * Test outcome (HTTP 200 in every case — a failed probe is the RESULT of the
 * operation, not a transport error; the reason drives the fixed UI copy).
 */
export const LoreTestResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), baseUrl: NonEmptyStringSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["invalid_url", "insecure_http", "missing_token", "unauthorized", "unreachable"]),
  }),
]);
export type LoreTestResponse = z.infer<typeof LoreTestResponseSchema>;

/** Connection-write response: the new connection facts (never the token). */
export const LoreConnectionResponseSchema = LoreConnectionSchema;
export type LoreConnectionResponse = z.infer<typeof LoreConnectionResponseSchema>;
