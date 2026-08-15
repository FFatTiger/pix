// Test-only SDK-free projection of the data/resource/trust ports.
//
// A1 ships only the agent runtime surface in src/. The session/model/
// credential/resource/trust ports are deferred, so the SDK-free projection
// that maps a Pi SDK data backend onto the canonical Runtime Core ports lives
// here in test/ and is consumed only by the contract harness. Production src/
// must never carry these deferred port implementations.
import type {
  AuthInput,
  AuthProviderInfo,
  AuthProviderStatus,
  AuthResult,
  CredentialStorePort,
  ModelCatalogPort,
  ModelInfo,
  ModelRef,
  ModelSelector,
  PluginInfo,
  PluginWriteInput,
  ProjectTrustPort,
  ProjectTrustState,
  ProjectTrustStatus,
  ResourceCatalogStorePort,
  SessionCatalogPort,
  SessionContext,
  SessionTree,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
  SessionLocatorPort,
  SkillInfo,
  SkillInstallInput,
  SlashCommandInfo,
  TrustGateResult,
} from "@fffattiger/pix-runtime-core";

export interface PiSdkDataBackend {
  listSessions(): Promise<readonly SessionHeader[]>;
  readSession(sessionId: string): Promise<SessionDetail>;
  readSessionContext(sessionId: string, leafId?: string): Promise<SessionContext>;
  readSessionTree(sessionId: string): Promise<SessionTree>;
  deleteSession(sessionId: string): Promise<void>;
  locate(sessionId: string): Promise<SessionLocation>;
  resolveLeafId(sessionId: string, targetId?: string): Promise<string>;
  listModels(): Promise<readonly ModelInfo[]>;
  getDefaultModel(): Promise<ModelRef | null>;
  resolveModel(provider: string, modelId: string): Promise<ModelInfo>;
  listProviders(): Promise<readonly AuthProviderInfo[]>;
  providerStatus(providerId: string): Promise<AuthProviderStatus>;
  authorize(providerId: string, input: AuthInput): Promise<AuthResult>;
  logout(providerId: string): Promise<void>;
  listSkills(): Promise<readonly SkillInfo[]>;
  listPlugins(): Promise<readonly PluginInfo[]>;
  listCommands(): Promise<readonly SlashCommandInfo[]>;
  writePlugin(name: string, content: string, enabled: boolean): Promise<PluginInfo>;
  setPluginEnabled(name: string, enabled: boolean): Promise<PluginInfo>;
  installSkill(source: string, name?: string): Promise<SkillInfo>;
  updateSkill(name: string): Promise<SkillInfo>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo>;
  reloadResources(): Promise<void>;
  getTrust(cwd: string): Promise<{ level: ProjectTrustState; reason?: string }>;
  setTrust(cwd: string, level: ProjectTrustState): Promise<void>;
}

export function createPortsFromBackend(backend: PiSdkDataBackend): {
  sessionCatalog: SessionCatalogPort;
  sessionLocator: SessionLocatorPort;
  modelCatalog: ModelCatalogPort;
  credentialStore: CredentialStorePort;
  resourceCatalog: ResourceCatalogStorePort;
  projectTrust: ProjectTrustPort;
} {
  return {
    sessionCatalog: {
      async listSessions(filter?: SessionListFilter) {
        let sessions = [...await backend.listSessions()];
        if (filter?.cwd) sessions = sessions.filter((session) => session.cwd === filter.cwd);
        if (filter?.offset !== undefined) sessions = sessions.slice(filter.offset);
        if (filter?.limit !== undefined) sessions = sessions.slice(0, filter.limit);
        return sessions;
      },
      readSession: (id) => backend.readSession(id),
      readSessionContext: (id, options) => backend.readSessionContext(id, options?.leafId),
      readSessionTree: (id) => backend.readSessionTree(id),
      deleteSession: (id) => backend.deleteSession(id),
    },
    sessionLocator: {
      locate: (id) => backend.locate(id),
      resolveLeafId: (id, target) => backend.resolveLeafId(id, target),
    },
    modelCatalog: {
      listModels: () => backend.listModels(),
      getDefaultModel: () => backend.getDefaultModel(),
      resolveModel: (selector: ModelSelector) => backend.resolveModel(selector.provider, selector.modelId),
    },
    credentialStore: {
      listProviders: () => backend.listProviders(),
      getProviderStatus: (id) => backend.providerStatus(id),
      isConfigured: async (id) => (await backend.providerStatus(id)).authorized,
      authorize: (id, input) => backend.authorize(id, input),
      logout: (id) => backend.logout(id),
    },
    resourceCatalog: {
      listSkills: () => backend.listSkills(),
      listPlugins: () => backend.listPlugins(),
      listCommands: () => backend.listCommands(),
      writePlugin: (input: PluginWriteInput) => backend.writePlugin(input.name, input.content, input.enabled ?? true),
      setPluginEnabled: (name, enabled) => backend.setPluginEnabled(name, enabled),
      installSkill: (input: SkillInstallInput) => backend.installSkill(input.source, input.name),
      updateSkill: (name) => backend.updateSkill(name),
      setSkillEnabled: (name, enabled) => backend.setSkillEnabled(name, enabled),
      reload: () => backend.reloadResources(),
    },
    projectTrust: {
      async getProjectTrustState(cwd): Promise<ProjectTrustState> { return (await backend.getTrust(cwd)).level; },
      async getTrust(cwd): Promise<ProjectTrustStatus> { const status = await backend.getTrust(cwd); return { cwd, ...status }; },
      async isTrusted(cwd) { return (await backend.getTrust(cwd)).level === "trusted"; },
      async setTrust(cwd, level): Promise<ProjectTrustStatus> { await backend.setTrust(cwd, level); const status = await backend.getTrust(cwd); return { cwd, ...status }; },
      async canReloadResources(cwd): Promise<TrustGateResult> { const status = await backend.getTrust(cwd); return { allowed: status.level === "trusted", level: status.level, ...(status.level === "trusted" ? {} : { reason: status.reason ?? "project is not trusted" }) }; },
    },
  };
}
