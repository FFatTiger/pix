import { z } from "zod";
import {
  AuthProviderInfoSchema,
  AuthProviderStatusSchema,
  HostCapabilitiesSchema,
  HostModeSchema,
  PluginInfoSchema,
  SessionContextSchema,
  SessionDetailSchema,
  SessionHeaderSchema,
  SkillInfoSchema,
} from "@fffattiger/pi-web-protocol";

export const SuccessSchema = z.strictObject({ success: z.boolean() });
export const OkSchema = z.strictObject({ ok: z.boolean() });

export const GateStatusSchema = z.strictObject({
  required: z.boolean(),
  authenticated: z.boolean(),
  mode: HostModeSchema,
  status: z.enum(["enabled", "disabled", "unconfigured", "error"]),
});
export type GateStatus = z.infer<typeof GateStatusSchema>;
export const GateLoginResultSchema = z.strictObject({ ok: z.literal(true), next: z.string() });
export const GateLogoutResultSchema = z.strictObject({ ok: z.literal(true), revoked: z.boolean() });

export const QueryRevisionSchema = z.number().int().nonnegative().safe();
export const SessionListSchema = z.union([
  z.array(SessionHeaderSchema),
  z.strictObject({ sessions: z.array(SessionHeaderSchema), revision: QueryRevisionSchema.optional() }),
]).transform((value) => Array.isArray(value) ? { sessions: value } : value);
export const SessionDetailResponseSchema = z.union([
  SessionDetailSchema.transform((session) => ({ session })),
  z.strictObject({ session: SessionDetailSchema, revision: QueryRevisionSchema.optional() }),
]);
export const SessionContextResponseSchema = z.union([
  SessionContextSchema.transform((context) => ({ context })),
  z.strictObject({ context: SessionContextSchema, revision: QueryRevisionSchema.optional() }),
]);
export const ThinkingResponseSchema = z.strictObject({ thinking: z.string(), entryId: z.string().optional() });
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

export const ModelRefResponseSchema = z.strictObject({ id: z.string(), name: z.string(), provider: z.string() });
export const ModelsResponseSchema = z.strictObject({
  models: z.record(z.string(), z.string()),
  modelList: z.array(ModelRefResponseSchema),
  defaultModel: z.strictObject({ provider: z.string(), modelId: z.string() }).nullable(),
  thinkingLevels: z.record(z.string(), z.array(z.string())),
  thinkingLevelMaps: z.record(z.string(), z.record(z.string(), z.string().nullable())),
  thinkingLevelPins: z.record(z.string(), z.string()),
  modelError: z.string().optional(),
  modelScopeWarnings: z.array(z.string()).optional(),
});
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const ModelsConfigSchema = z.record(z.string(), JsonValueSchema);
export const ModelCatalogEntrySchema = z.strictObject({
  id: z.string(), provider: z.string(), name: z.string().optional(), family: z.string().optional(), contextWindow: z.number().positive().optional(),
});
export const ModelRecommendationSchema = z.strictObject({ provider: z.string(), modelId: z.string(), baseUrl: z.string().optional() });
export const ModelCatalogResponseSchema = z.strictObject({
  models: z.array(ModelCatalogEntrySchema),
  recommendation: ModelRecommendationSchema.nullable().optional(),
  source: z.string(),
});
export const ModelDiscoverResponseSchema = z.strictObject({ models: z.array(ModelCatalogEntrySchema), warnings: z.array(z.string()).optional() });
export const ModelTestResponseSchema = z.strictObject({ ok: z.boolean(), message: z.string().optional() });

export const FileEntrySchema = z.strictObject({ name: z.string(), isDir: z.boolean(), isSymlink: z.boolean() });
export const FileListResponseSchema = z.strictObject({ path: z.string(), entries: z.array(FileEntrySchema) });
export const FileMetaResponseSchema = z.strictObject({ path: z.string(), size: z.number().nonnegative(), modified: z.string(), isDirectory: z.boolean(), mime: z.string().nullable() });
export const FileTextResponseSchema = z.strictObject({ content: z.string(), language: z.string(), size: z.number().nonnegative() });
export const UploadResponseSchema = z.strictObject({ uploaded: z.array(z.string()), skipped: z.array(z.string()) });
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
  path: z.string(), branch: z.string().nullable(), isMain: z.boolean(), authorized: z.boolean(),
});
export const WorktreeListResponseSchema = z.strictObject({ projectRoot: z.string(), isGit: z.boolean(), isTopLevel: z.boolean(), worktrees: z.array(WorktreeInfoSchema) });
export const WorktreeCreateResponseSchema = z.strictObject({ path: z.string(), branch: z.string() });

export const ResourceDiagnosticSchema = z.strictObject({ type: z.enum(["warning", "error"]), message: z.string(), source: z.string().optional(), path: z.string().optional() });
export const SkillsResponseSchema = z.union([
  z.array(SkillInfoSchema),
  z.strictObject({ skills: z.array(SkillInfoSchema), diagnostics: z.array(ResourceDiagnosticSchema).optional(), projectResourcesLoaded: z.boolean().optional() }),
]).transform((value) => Array.isArray(value) ? { skills: value } : value);
export const SkillSearchItemSchema = z.strictObject({ package: z.string(), installs: z.string(), url: z.string() });
export const SkillSearchResponseSchema = z.strictObject({ results: z.array(SkillSearchItemSchema) });
export const SkillMutationResponseSchema = z.union([SkillInfoSchema, SuccessSchema, OkSchema]);

export const PluginResourceCountsSchema = z.strictObject({ extensions: z.number().int().nonnegative(), skills: z.number().int().nonnegative(), prompts: z.number().int().nonnegative(), themes: z.number().int().nonnegative() });
export const PluginResourceSchema = z.strictObject({ kind: z.enum(["extension", "skill", "prompt", "theme"]), name: z.string(), path: z.string(), relativePath: z.string() });
export const PluginPackageSchema = z.strictObject({
  source: z.string(), scope: z.enum(["global", "project"]), filtered: z.boolean(), disabled: z.boolean(), installedPath: z.string().optional(), packageName: z.string().optional(), version: z.string().optional(), configuredVersion: z.string().optional(), counts: PluginResourceCountsSchema, resources: z.array(PluginResourceSchema), status: z.enum(["loaded", "installed", "missing", "disabled"]),
});
export const PluginsResponseSchema = z.union([
  z.array(PluginInfoSchema).transform((plugins) => ({ plugins })),
  z.strictObject({ plugins: z.array(PluginInfoSchema) }),
  z.strictObject({ packages: z.array(PluginPackageSchema), totals: PluginResourceCountsSchema, diagnostics: z.array(ResourceDiagnosticSchema), projectResourcesLoaded: z.boolean() }),
]);
export const PluginMutationResponseSchema = z.union([PluginInfoSchema, SuccessSchema, OkSchema]);

export const AuthProvidersResponseSchema = z.union([
  z.array(AuthProviderInfoSchema),
  z.strictObject({ providers: z.array(AuthProviderInfoSchema) }),
]).transform((value) => Array.isArray(value) ? { providers: value } : value);
export const AuthStatusesResponseSchema = z.union([
  z.array(AuthProviderStatusSchema),
  z.strictObject({ providers: z.array(AuthProviderStatusSchema) }),
]).transform((value) => Array.isArray(value) ? { providers: value } : value);
export const AuthMutationResponseSchema = z.union([
  AuthProviderStatusSchema,
  z.strictObject({ ok: z.boolean(), providerId: z.string().optional(), authorized: z.boolean().optional(), pending: z.boolean().optional(), message: z.string().optional() }),
]);
