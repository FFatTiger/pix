import {
  BuiltInCapabilityConfigResponseSchema,
  CompactionSettingsResponseSchema,
  LoreConnectionResponseSchema,
  LoreTestResponseSchema,
  McpImportPreviewResponseSchema,
  McpSettingsResponseSchema,
  MemorySettingsResponseSchema,
  SubagentSettingsResponseSchema,
  ToolSettingsResponseSchema,
  type BuiltInCapabilityConfigMutation,
  type SettingsConfigMutation,
  type CompactionSettingsMutation,
  type LoreConnectionMutation,
  type LoreTestRequest,
  type McpEnabledMutationWire,
  type McpImportRequestWire,
  type McpProbeRequestWire,
  type McpServerWriteWire,
  type MemoryProviderMutation,
  type SubagentSettingsMutation,
  type ToolSettingsMutation,
} from "@fffattiger/pix-protocol";
import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  AuthProvidersResponseSchema,
  AuthProviderStatusResponseSchema,
  CommandsResponseSchema,
  PluginsResponseSchema,
  SessionIdleTimeoutResponseSchema,
  SettingsConfigResponseSchema,
  SkillsResponseSchema,
  TrustResponseSchema,
} from "./schemas";

/**
 * Read-only configuration / catalog APIs (D3B) + the one mounted catalog
 * mutation (trust set-trusted).
 *
 * Frozen product decision: Client does not expose Host-unmounted mutation /
 * OAuth call surfaces (skills search/install/update/toggle, plugins mutate,
 * auth allProviders/apiKey/login/logout). Only honest GET wrappers remain —
 * plus `trust.setTrusted`, the D3B trust-mutation slice (POST /v1/trust,
 * `project.trust` capability): strictly `{cwd, level: "trusted"}`.
 */
export function createConfigurationApi(http: HttpClient) {
  return {
    skills: {
      list: (cwd?: string, signal?: AbortSignal) =>
        http.get(urls.skills.list(cwd), {
          schema: SkillsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    plugins: {
      list: (cwd?: string, signal?: AbortSignal) =>
        http.get(urls.plugins.list(cwd), {
          schema: PluginsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    commands: {
      list: (cwd?: string, signal?: AbortSignal) =>
        http.get(urls.commands.list(cwd), {
          schema: CommandsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    trust: {
      get: (cwd: string, signal?: AbortSignal) =>
        http.get(urls.trust.get(cwd), {
          schema: TrustResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /**
       * Record an explicit trusted decision. The request body is exactly
       * `{cwd, level: "trusted"}` and the response reuses the strict GET
       * trust-state schema (read-after-write projection from the Host).
       */
      setTrusted: (cwd: string, signal?: AbortSignal) =>
        http.post(
          urls.trust.mutate(),
          { cwd, level: "trusted" },
          {
            schema: TrustResponseSchema,
            ...(signal === undefined ? {} : { signal }),
          },
        ),
    },
    auth: {
      providers: (signal?: AbortSignal) =>
        http.get(urls.auth.providers(), {
          schema: AuthProvidersResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      providerStatus: (providerId: string, signal?: AbortSignal) =>
        http.get(urls.auth.providerStatus(providerId), {
          schema: AuthProviderStatusResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    sessionSettings: {
      /** Current session idle-reclamation timeout (ms; 0 = disabled). */
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.sessionIdleTimeout(), {
          schema: SessionIdleTimeoutResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Set + persist the session idle-reclamation timeout. */
      set: (idleTimeoutMs: number, signal?: AbortSignal) =>
        http.put(
          urls.settings.sessionIdleTimeout(),
          { idleTimeoutMs },
          {
            schema: SessionIdleTimeoutResponseSchema,
            ...(signal === undefined ? {} : { signal }),
          },
        ),
    },
    builtIns: {
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.builtIns(), {
          schema: BuiltInCapabilityConfigResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      save: (input: BuiltInCapabilityConfigMutation, signal?: AbortSignal) =>
        http.put(urls.settings.builtIns(), input, {
          schema: BuiltInCapabilityConfigResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    subagents: {
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.subagents(), {
          schema: SubagentSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      save: (input: SubagentSettingsMutation, signal?: AbortSignal) =>
        http.put(urls.settings.subagents(), input, {
          schema: SubagentSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    compaction: {
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.compaction(), {
          schema: CompactionSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      save: (input: CompactionSettingsMutation, signal?: AbortSignal) =>
        http.put(urls.settings.compaction(), input, {
          schema: CompactionSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    memory: {
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.memory(), {
          schema: MemorySettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      save: (input: MemoryProviderMutation, signal?: AbortSignal) =>
        http.put(urls.settings.memory(), input, {
          schema: MemorySettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    memoryLore: {
      save: (input: LoreConnectionMutation, signal?: AbortSignal) =>
        http.put(urls.settings.memoryLore(), input, {
          schema: LoreConnectionResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      test: (input: LoreTestRequest, signal?: AbortSignal) =>
        http.post(urls.settings.memoryLoreTest(), input, {
          schema: LoreTestResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    mcp: {
      /** Global MCP servers + cached probe results (secrets never ride this). */
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.mcp(), {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Create/replace one server. */
      upsert: (input: McpServerWriteWire, signal?: AbortSignal) =>
        http.post(urls.settings.mcpServers(), input, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Edit one server (PUT — the body name must equal the path name). */
      update: (name: string, input: McpServerWriteWire, signal?: AbortSignal) =>
        http.put(urls.settings.mcpServer(name), input, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Enable/disable toggle. */
      setEnabled: (name: string, input: McpEnabledMutationWire, signal?: AbortSignal) =>
        http.patch(urls.settings.mcpServer(name), input, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      remove: (name: string, signal?: AbortSignal) =>
        http.delete(urls.settings.mcpServer(name), undefined, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Probe one server; `refresh: true` bypasses the 30s server cache. */
      test: (name: string, input: McpProbeRequestWire, signal?: AbortSignal) =>
        http.post(urls.settings.mcpServerTest(name), input, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Validate pasted JSON and report what an import would do (no write). */
      importPreview: (input: McpImportRequestWire, signal?: AbortSignal) =>
        http.post(urls.settings.mcpImportPreview(), input, {
          schema: McpImportPreviewResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** Import pasted JSON (all-or-nothing on the server). */
      import: (input: McpImportRequestWire, signal?: AbortSignal) =>
        http.post(urls.settings.mcpImport(), input, {
          schema: McpSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    settingsFile: {
      /** Global agent-dir settings.json raw text (comments preserved). */
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.configFile(), {
          schema: SettingsConfigResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** CAS write of the full settings.json text. */
      save: (input: SettingsConfigMutation, signal?: AbortSignal) =>
        http.put(urls.settings.configFile(), input, {
          schema: SettingsConfigResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    tools: {
      /** Global tool selection (pixDefaultTools): all / custom allowlist / native. */
      get: (signal?: AbortSignal) =>
        http.get(urls.settings.tools(), {
          schema: ToolSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      /** CAS write of the selection (`null` = all, array = allowlist). */
      save: (input: ToolSettingsMutation, signal?: AbortSignal) =>
        http.put(urls.settings.tools(), input, {
          schema: ToolSettingsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
  };
}
export type ConfigurationApi = ReturnType<typeof createConfigurationApi>;
