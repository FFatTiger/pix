import { z } from "zod";
import {
  AuthProviderInfoSchema,
  AuthProviderStatusSchema,
  HostCapabilitiesSchema,
  HostModeSchema,
  ModelInfoSchema,
  ModelRefSchema,
  ModelDiscoveryResponseSchema,
  ModelsConfigResponseSchema,
  PluginInfoSchema,
  ProjectPageSchema,
  SessionContextSchema,
  SessionDetailSchema,
  SessionPageSchema,
  SessionTreeSchema,
  SkillInfoSchema,
  SlashCommandInfoSchema,
  TrustLevelSchema,
} from "@fffattiger/pix-protocol";

export const SuccessSchema = z.strictObject({ success: z.boolean() });
export const OkSchema = z.strictObject({ ok: z.boolean() });

/** GET/PUT /v1/settings/session-idle-timeout — session idle-reclamation timeout. */
export const SessionIdleTimeoutResponseSchema = z.strictObject({
  idleTimeoutMs: z.number().int().nonnegative().safe(),
});
export type SessionIdleTimeoutResponse = z.infer<typeof SessionIdleTimeoutResponseSchema>;

export const GateStatusSchema = z.strictObject({
  required: z.boolean(),
  authenticated: z.boolean(),
  mode: HostModeSchema,
  status: z.enum(["enabled", "disabled", "unconfigured", "error"]),
});
export type GateStatus = z.infer<typeof GateStatusSchema>;
export const GateLoginResultSchema = z.strictObject({ ok: z.literal(true), next: z.string() });
export const GateLogoutResultSchema = z.strictObject({ ok: z.literal(true), revoked: z.boolean() });
export const GatePasswordChangeResultSchema = z.strictObject({ ok: z.literal(true) });
export const PreferencesMapSchema = z.record(z.string(), z.string());
export const PreferencesResponseSchema = z.strictObject({ preferences: PreferencesMapSchema });
export const PreferencesUpdateResultSchema = z.strictObject({ ok: z.literal(true), preferences: PreferencesMapSchema });

export const QueryRevisionSchema = z.number().int().nonnegative().safe();
export const SessionListSchema = SessionPageSchema;
export const ProjectListSchema = ProjectPageSchema;
export const SessionDetailResponseSchema = z.union([
  SessionDetailSchema.transform((session) => ({ session })),
  z.strictObject({ session: SessionDetailSchema, revision: QueryRevisionSchema.optional() }),
]);
export const SessionContextResponseSchema = z.union([
  SessionContextSchema.transform((context) => ({ context })),
  z.strictObject({ context: SessionContextSchema, revision: QueryRevisionSchema.optional() }),
]);
/**
 * GET /v1/sessions/:id/tree — the normalized branch tree under `tree`
 * (strict DTO: extra/malformed fields are rejected, never coerced). The tree
 * carries the PERSISTED catalog head as `currentLeafId`; live mode overrides
 * the active leaf from the runtime snapshot (see lib/session-tree).
 */
export const SessionTreeResponseSchema = z.union([
  SessionTreeSchema.transform((tree) => ({ tree })),
  z.strictObject({ tree: SessionTreeSchema, revision: QueryRevisionSchema.optional() }),
]);
export type SessionTreeResponse = z.infer<typeof SessionTreeResponseSchema>;
/** GET /v1/sessions/:id/entries/:entryId/thinking?blockIndex= — deferred thinking block content (Host contract: blockIndex required, entryId echoed). */
export const ThinkingResponseSchema = z.strictObject({ thinking: z.string(), entryId: z.string() });
export const BashOutputResponseSchema = z.strictObject({ output: z.string(), truncated: z.boolean().optional(), fullOutputPath: z.string().optional() });

export const CapabilitiesResponseSchema = z.strictObject({
  ok: z.literal(true),
  sessiond: z.enum(["up", "down", "unknown"]),
  capabilities: HostCapabilitiesSchema,
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

export const HealthResponseSchema = CapabilitiesResponseSchema.extend({ service: z.string() });

export const BootstrapGateStatusSchema = z.strictObject({
  required: z.boolean(),
  status: z.enum(["enabled", "disabled", "unconfigured", "error"]),
});
export const BootstrapResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.string(),
  protocolVersion: z.number(),
  sessiond: z.enum(["up", "down", "unknown"]),
  capabilities: HostCapabilitiesSchema,
  mode: HostModeSchema,
  gate: BootstrapGateStatusSchema,
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

/* —— D3B Host catalog response wrappers (strict; no legacy Next unions) —— */

/** GET /v1/models (global catalog) — Host projector shape. */
export const ModelsResponseSchema = z.strictObject({
  models: z.array(ModelInfoSchema),
  defaultModel: ModelRefSchema.nullable(),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
export { ModelsConfigResponseSchema };
export type ModelsConfigResponse = z.infer<typeof ModelsConfigResponseSchema>;
export { SettingsConfigResponseSchema } from "@fffattiger/pix-protocol";
export type { SettingsConfigResponse } from "@fffattiger/pix-protocol";
export { ModelDiscoveryResponseSchema };
export type ModelDiscoveryResponse = z.infer<typeof ModelDiscoveryResponseSchema>;

/** GET /v1/auth/providers */
export const AuthProvidersResponseSchema = z.strictObject({
  providers: z.array(AuthProviderInfoSchema),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;

/** GET /v1/auth/providers/:id/status */
export const AuthProviderStatusResponseSchema = z.strictObject({
  status: AuthProviderStatusSchema,
  configured: z.boolean(),
});
export type AuthProviderStatusResponse = z.infer<typeof AuthProviderStatusResponseSchema>;

/** GET /v1/skills?cwd= */
export const SkillsResponseSchema = z.strictObject({
  skills: z.array(SkillInfoSchema),
});
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>;

/** GET /v1/plugins?cwd= */
export const PluginsResponseSchema = z.strictObject({
  plugins: z.array(PluginInfoSchema),
});
export type PluginsResponse = z.infer<typeof PluginsResponseSchema>;

/** GET /v1/commands?cwd= */
export const CommandsResponseSchema = z.strictObject({
  commands: z.array(SlashCommandInfoSchema),
});
export type CommandsResponse = z.infer<typeof CommandsResponseSchema>;

/**
 * GET /v1/trust?cwd= — Host projector shape.
 * Do NOT reuse ProjectTrustStatusSchema (different product DTO).
 */
export const CanReloadResourcesSchema = z.strictObject({
  allowed: z.boolean(),
  level: TrustLevelSchema,
  reason: z.string().optional(),
});
export const TrustResponseSchema = z.strictObject({
  cwd: z.string().min(1),
  level: TrustLevelSchema,
  trusted: z.boolean(),
  canReloadResources: CanReloadResourcesSchema,
});
export type TrustResponse = z.infer<typeof TrustResponseSchema>;

/* —— Workspace / files / git (unchanged non-catalog domains) —— */

export const FileEntrySchema = z.strictObject({ name: z.string(), isDir: z.boolean(), isSymlink: z.boolean() });
export const FileListResponseSchema = z.strictObject({ path: z.string(), entries: z.array(FileEntrySchema) });
export const FileMetaResponseSchema = z.strictObject({ path: z.string(), size: z.number().nonnegative(), modified: z.string(), isDirectory: z.boolean(), mime: z.string().nullable() });
export const FileTextResponseSchema = z.strictObject({ content: z.string(), language: z.string(), size: z.number().nonnegative() });
export const UploadErrorSchema = z.strictObject({ name: z.string(), error: z.string() });
export const UploadResponseSchema = z.strictObject({
  uploaded: z.array(z.string()),
  skipped: z.array(z.string()),
  errors: z.array(UploadErrorSchema),
});
/**
 * POST /v1/files?op=upload-check — conflict preflight for the file workspace
 * upload state machine (source contract: names that already exist under the
 * target directory and names that cannot be replaced). Live on the Host.
 */
export const UploadCheckResponseSchema = z.strictObject({
  conflicts: z.array(z.string()),
  nonReplaceable: z.array(z.string()),
});
export type UploadCheckResponse = z.infer<typeof UploadCheckResponseSchema>;
/**
 * SSE `change` event payload of GET /v1/files/watch?path= (live on the Host).
 * Loose: the viewer only reads `size` when present.
 */
export const FileWatchChangeSchema = z.looseObject({ size: z.number().optional() });
export type FileWatchChange = z.infer<typeof FileWatchChangeSchema>;
export const FileIndexItemSchema = z.strictObject({ path: z.string(), isDir: z.literal(false) });
export const FileIndexResponseSchema = z.union([
  z.strictObject({ files: z.array(z.string()), truncated: z.boolean() }),
  z.strictObject({ matches: z.array(FileIndexItemSchema), truncated: z.boolean() }),
]);

export const GitFileSchema = z.strictObject({
  filePath: z.string(), status: z.string(), code: z.string(), indexStatus: z.string(), worktreeStatus: z.string(),
});
export const GitStatusResponseSchema = z.strictObject({
  isGitRepository: z.boolean(), repositoryRoot: z.string().nullable(), files: z.array(GitFileSchema), additions: z.number().nonnegative(), deletions: z.number().nonnegative(),
});
export const GitDiffResponseSchema = z.union([
  z.strictObject({ supported: z.literal(false) }),
  z.strictObject({ supported: z.literal(true), status: z.string(), patch: z.string() }),
]);

export const CwdValidateResponseSchema = z.strictObject({ success: z.literal(true), cwd: z.string() });
export const CwdBrowseResponseSchema = z.strictObject({ path: z.string(), parentPath: z.string().nullable(), directories: z.array(z.string()) });
export const CwdRootsResponseSchema = z.strictObject({ roots: z.array(z.string()), defaultCwd: z.string().nullable() });
export const CwdDefaultResponseSchema = z.strictObject({ cwd: z.string(), projectRoot: z.string() });

export const WorktreeInfoSchema = z.strictObject({
  path: z.string(), branch: z.string().nullable(), isMain: z.boolean(), authorized: z.boolean(), managedByPix: z.boolean(),
});
export const WorktreeListResponseSchema = z.strictObject({ projectRoot: z.string(), isGit: z.boolean(), isTopLevel: z.boolean(), worktrees: z.array(WorktreeInfoSchema) });
export const WorktreeCreateResponseSchema = z.strictObject({ path: z.string(), branch: z.string(), managedByPix: z.literal(true) });
export const WorktreeDeleteResponseSchema = z.strictObject({ success: z.literal(true), fallbackCwd: z.string(), branchRetained: z.literal(true) });
