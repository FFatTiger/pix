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
