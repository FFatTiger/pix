import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/**
 * Wire projection of the MCP settings surface (global `<agentDir>/mcp.json`,
 * the same document Pi's `builtin:mcp` extension reads at session start).
 *
 * Canonical owner is `packages/runtime-core/src/mcp-settings.ts`; Protocol
 * cannot import runtime-core (architecture rule 7), so this module mirrors
 * the shapes and cross-package contract tests pin the two copies. Secret
 * rule: `env`/`headers` literal values are WRITE-ONLY — every response schema
 * here carries them only as `{ redacted: true }`; `${VAR}` and `!command`
 * references round-trip verbatim.
 */

export const McpServerKindSchema = z.enum(["stdio", "http"]);
export type McpServerKindWire = z.infer<typeof McpServerKindSchema>;
export const MCP_SERVER_KINDS = McpServerKindSchema.options;

export const McpProbeStateSchema = z.enum([
  "connected",
  "needs_auth",
  "failed",
  "disabled",
  "unknown",
]);
export type McpProbeStateWire = z.infer<typeof McpProbeStateSchema>;
export const MCP_PROBE_STATES = McpProbeStateSchema.options;

/** `${VAR}` / `!command` whole-value references pass through; literals never do. */
export const MCP_SECRET_REFERENCE_RE = /^(?:\$\{[^}]{1,256}\}|!.{1,512})$/;
export const McpSecretValueSchema = z.discriminatedUnion("redacted", [
  z.strictObject({ redacted: z.literal(true) }),
  z.strictObject({ redacted: z.literal(false), value: NonEmptyStringSchema.regex(MCP_SECRET_REFERENCE_RE) }),
]);
export type McpSecretValueWire = z.infer<typeof McpSecretValueSchema>;

export const McpToolInfoSchema = z.strictObject({
  name: NonEmptyStringSchema,
  description: z.string(),
});
export type McpToolInfoWire = z.infer<typeof McpToolInfoSchema>;

export const McpProbeStatusSchema = z.strictObject({
  state: McpProbeStateSchema,
  tools: z.array(McpToolInfoSchema),
  error: z.string().nullable(),
  stderrTail: z.array(z.string()),
  probedAt: z.number().int().nonnegative().nullable(),
});
export type McpProbeStatusWire = z.infer<typeof McpProbeStatusSchema>;

export const McpServerSnapshotSchema = z.strictObject({
  name: NonEmptyStringSchema,
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
  kind: McpServerKindSchema.nullable(),
  enabled: z.boolean(),
  command: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  env: z.record(z.string(), McpSecretValueSchema).nullable(),
  cwd: z.string().nullable(),
  url: z.string().nullable(),
  headers: z.record(z.string(), McpSecretValueSchema).nullable(),
  timeout: z.number().int().positive().nullable(),
  description: z.string().nullable(),
  status: McpProbeStatusSchema,
});
export type McpServerSnapshotWire = z.infer<typeof McpServerSnapshotSchema>;

export const McpSettingsResponseSchema = z.strictObject({
  servers: z.array(McpServerSnapshotSchema),
});
export type McpSettingsResponse = z.infer<typeof McpSettingsResponseSchema>;

/** Per-key env/headers write intent (same modes as the models.json apiKey). */
export const McpSecretMutationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("preserve") }),
  z.strictObject({ mode: z.literal("remove") }),
  z.strictObject({ mode: z.literal("replace"), value: NonEmptyStringSchema }),
]);
export type McpSecretMutationWire = z.infer<typeof McpSecretMutationSchema>;

export const McpServerWriteSchema = z.strictObject({
  name: NonEmptyStringSchema,
  kind: McpServerKindSchema,
  command: NonEmptyStringSchema.optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), McpSecretMutationSchema).optional(),
  cwd: NonEmptyStringSchema.optional(),
  url: NonEmptyStringSchema.optional(),
  headers: z.record(z.string(), McpSecretMutationSchema).optional(),
  timeout: z.number().int().positive().max(86_400).optional(),
  description: z.string().max(2_000).optional(),
});
export type McpServerWriteWire = z.infer<typeof McpServerWriteSchema>;

export const McpEnabledMutationSchema = z.strictObject({
  enabled: z.boolean(),
});
export type McpEnabledMutationWire = z.infer<typeof McpEnabledMutationSchema>;

export const McpProbeRequestSchema = z.strictObject({
  refresh: z.boolean(),
});
export type McpProbeRequestWire = z.infer<typeof McpProbeRequestSchema>;

/** Paste-import body: the raw pasted JSON text (≤128 KiB, same as the file bound). */
export const McpImportRequestSchema = z.strictObject({
  json: z.string().min(1).max(128 * 1024),
});
export type McpImportRequestWire = z.infer<typeof McpImportRequestSchema>;

export const McpImportPreviewEntrySchema = z.strictObject({
  name: NonEmptyStringSchema,
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
  overwrite: z.boolean(),
  kind: McpServerKindSchema.nullable(),
});
export type McpImportPreviewEntryWire = z.infer<typeof McpImportPreviewEntrySchema>;

export const McpImportPreviewResponseSchema = z.strictObject({
  entries: z.array(McpImportPreviewEntrySchema),
});
export type McpImportPreviewResponse = z.infer<typeof McpImportPreviewResponseSchema>;
