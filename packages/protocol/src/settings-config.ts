import { z } from "zod";

/** 256 KiB raw-text bound shared by the response and the mutation. */
export const SETTINGS_CONFIG_MAX_BYTES = 256 * 1024;

export const SettingsConfigResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string().max(SETTINGS_CONFIG_MAX_BYTES),
});
export type SettingsConfigResponse = z.infer<typeof SettingsConfigResponseSchema>;

export const SettingsConfigMutationSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string().min(1).max(SETTINGS_CONFIG_MAX_BYTES),
});
export type SettingsConfigMutation = z.infer<typeof SettingsConfigMutationSchema>;

/**
 * Wire projection of the global tool selection (`pixDefaultTools`).
 *
 * Canonical owner is `packages/runtime-core/src/settings-config.ts`
 * (`ToolsSelection`); Protocol cannot import runtime-core (architecture rule
 * 7), so this module mirrors the shapes and cross-package contract tests pin
 * the two copies.
 */
const ToolNameSchema = z.string().min(1).max(200);

export const ToolsSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("custom"), toolNames: z.array(ToolNameSchema) }),
  z.strictObject({ mode: z.literal("native"), toolNames: z.array(ToolNameSchema) }),
]);
export type ToolsSelectionWire = z.infer<typeof ToolsSelectionSchema>;

export const ToolSettingsResponseSchema = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  selection: ToolsSelectionSchema,
});
export type ToolSettingsResponse = z.infer<typeof ToolSettingsResponseSchema>;

export const ToolSettingsMutationSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  /** null = enable all; an array (possibly empty) = the explicit allowlist. */
  toolNames: z.array(ToolNameSchema).nullable(),
});
export type ToolSettingsMutation = z.infer<typeof ToolSettingsMutationSchema>;
