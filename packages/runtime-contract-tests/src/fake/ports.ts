/**
 * Reference implementations of the non-runtime ports (catalog / locator /
 * model / credential / resource / trust) backed by the in-memory store or
 * small static fixtures.
 */
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
  ProjectTrustPort,
  ProjectTrustStatus,
  ResourceCatalogPort,
  SessionCatalogPort,
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
  SessionLocatorPort,
  SkillInfo,
  SlashCommandInfo,
  TrustGateResult,
  TrustLevel,
} from "@fffattiger/pi-web-runtime-core";
import { makeRuntimeError } from "@fffattiger/pi-web-runtime-core";
import type { ReferenceSessionStore } from "./store.js";

/* ------------------------------------------------------------------ */
/* Model catalog                                                       */
/* ------------------------------------------------------------------ */

const MODELS: readonly ModelInfo[] = [
  {
    id: "claude-sonnet-4",
    provider: "anthropic",
    displayName: "Claude Sonnet 4",
    thinking: true,
    contextWindow: 200000,
  },
  {
    id: "claude-opus-4",
    provider: "anthropic",
    displayName: "Claude Opus 4",
    thinking: true,
    contextWindow: 200000,
  },
  {
    id: "gpt-5",
    provider: "openai",
    displayName: "GPT-5",
    thinking: true,
    contextWindow: 128000,
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    displayName: "GPT-5 mini",
    thinking: false,
    contextWindow: 128000,
  },
];

export class ReferenceModelCatalog implements ModelCatalogPort {
  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(MODELS);
  }

  getDefaultModel(): Promise<ModelRef> {
    return Promise.resolve({ id: "claude-sonnet-4", provider: "anthropic" });
  }

  async resolveModel(selector: ModelSelector): Promise<ModelInfo> {
    const model = MODELS.find(
      (m) => m.id === selector.modelId && m.provider === selector.provider,
    );
    if (!model) {
      throw makeRuntimeError(
        "not_found",
        `unknown model: ${selector.provider}/${selector.modelId}`,
      );
    }
    return model;
  }

  /** Non-throwing resolve used by the runtime factory. */
  resolve(selector: ModelSelector): ModelRef | null {
    const model = MODELS.find(
      (m) => m.id === selector.modelId && m.provider === selector.provider,
    );
    return model ? { id: model.id, provider: model.provider } : null;
  }
}

/* ------------------------------------------------------------------ */
/* Session catalog / locator (bound to the store)                      */
/* ------------------------------------------------------------------ */

export class ReferenceSessionCatalog implements SessionCatalogPort {
  constructor(private readonly store: ReferenceSessionStore) {}

  listSessions(filter?: SessionListFilter): Promise<readonly SessionHeader[]> {
    let headers = this.store.listSessions();
    if (filter?.cwd) {
      headers = headers.filter((header) => header.cwd === filter.cwd);
    }
    if (filter?.limit !== undefined) {
      headers = headers.slice(0, filter.limit);
    }
    return Promise.resolve(headers);
  }

  readSession(sessionId: string): Promise<SessionDetail> {
    return Promise.resolve(this.store.readSession(sessionId));
  }

  readSessionContext(
    sessionId: string,
    options?: { leafId?: string },
  ): Promise<SessionContext> {
    return Promise.resolve(this.store.readSessionContext(sessionId, options?.leafId));
  }

  deleteSession(sessionId: string): Promise<void> {
    this.store.deleteSession(sessionId);
    return Promise.resolve();
  }
}

export class ReferenceSessionLocator implements SessionLocatorPort {
  constructor(private readonly store: ReferenceSessionStore) {}

  locate(sessionId: string): Promise<SessionLocation> {
    return Promise.resolve(this.store.locate(sessionId));
  }

  resolveLeafId(sessionId: string, targetId?: string): Promise<string> {
    return Promise.resolve(this.store.resolveLeafId(sessionId, targetId));
  }
}

/* ------------------------------------------------------------------ */
/* Credential store — never returns raw credentials                    */
/* ------------------------------------------------------------------ */

const PROVIDERS: readonly AuthProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", methods: ["apiKey"] },
  { id: "openai", name: "OpenAI", methods: ["apiKey", "oauth"] },
  { id: "github", name: "GitHub", methods: ["oauth", "deviceCode"] },
];

export class ReferenceCredentialStore implements CredentialStorePort {
  private authorized = new Map<string, string>();

  listProviders(): Promise<readonly AuthProviderInfo[]> {
    return Promise.resolve(PROVIDERS);
  }

  getProviderStatus(providerId: string): Promise<AuthProviderStatus> {
    const account = this.authorized.get(providerId);
    return Promise.resolve({
      providerId,
      authorized: account !== undefined,
      ...(account === undefined ? {} : { accountName: account }),
    });
  }

  isConfigured(providerId: string): Promise<boolean> {
    return Promise.resolve(this.authorized.has(providerId));
  }

  authorize(providerId: string, input: AuthInput): Promise<AuthResult> {
    if (input.type === "apiKey" && input.apiKey.trim().length > 0) {
      this.authorized.set(providerId, "reference-account");
      return Promise.resolve({
        providerId,
        authorized: true,
        accountName: "reference-account",
      });
    }
    if (input.type === "start") {
      return Promise.resolve({
        providerId,
        authorized: false,
        pending: {
          verificationUrl: `https://example.com/device/${providerId}`,
          userCode: "ABCD-EFGH",
          expiresAt: Date.now() + 60_000,
        },
      });
    }
    return Promise.resolve({ providerId, authorized: false });
  }

  logout(providerId: string): Promise<void> {
    this.authorized.delete(providerId);
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ */
/* Resource catalog                                                    */
/* ------------------------------------------------------------------ */

export class ReferenceResourceCatalog implements ResourceCatalogPort {
  private skills: SkillInfo[] = [
    { name: "frontend", description: "Frontend codebase guidance", enabled: true },
    { name: "rust", description: "Rust project guidance", enabled: false },
  ];
  private plugins: PluginInfo[] = [
    { name: "pi-web-side-chat", version: "0.1.0", enabled: true },
  ];
  private commands: SlashCommandInfo[] = [
    { name: "compact", description: "Compact the conversation", source: "prompt" },
    { name: "clear", description: "Clear the queue", source: "prompt" },
    {
      name: "frontend-review",
      description: "Review frontend changes",
      source: "skill",
      sourceInfo: { skill: "frontend" },
    },
  ];

  listSkills(): Promise<readonly SkillInfo[]> {
    return Promise.resolve([...this.skills]);
  }

  listPlugins(): Promise<readonly PluginInfo[]> {
    return Promise.resolve([...this.plugins]);
  }

  listCommands(): Promise<readonly SlashCommandInfo[]> {
    return Promise.resolve([...this.commands]);
  }

  writePlugin(input: { name: string; content: string; enabled?: boolean }): Promise<PluginInfo> {
    if (!input.name.trim() || !input.content.trim()) {
      return Promise.reject(makeRuntimeError("invalid_input", "plugin name/content required"));
    }
    const plugin: PluginInfo = {
      name: input.name,
      version: "local",
      enabled: input.enabled ?? true,
    };
    this.plugins = [...this.plugins.filter((item) => item.name !== input.name), plugin];
    return Promise.resolve(plugin);
  }

  setPluginEnabled(name: string, enabled: boolean): Promise<PluginInfo> {
    const plugin = this.plugins.find((item) => item.name === name);
    if (!plugin) return Promise.reject(makeRuntimeError("not_found", `plugin not found: ${name}`));
    plugin.enabled = enabled;
    return Promise.resolve({ ...plugin });
  }

  installSkill(input: { source: string; name?: string }): Promise<SkillInfo> {
    const name = input.name ?? input.source.split("/").at(-1) ?? "installed-skill";
    const skill: SkillInfo = { name, enabled: true, version: "1.0.0", updateAvailable: false };
    this.skills = [...this.skills.filter((item) => item.name !== name), skill];
    return Promise.resolve(skill);
  }

  updateSkill(name: string): Promise<SkillInfo> {
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) return Promise.reject(makeRuntimeError("not_found", `skill not found: ${name}`));
    skill.version = "updated";
    skill.updateAvailable = false;
    return Promise.resolve({ ...skill });
  }

  setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo> {
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) return Promise.reject(makeRuntimeError("not_found", `skill not found: ${name}`));
    skill.enabled = enabled;
    return Promise.resolve({ ...skill });
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ */
/* Project trust                                                       */
/* ------------------------------------------------------------------ */

export class ReferenceProjectTrust implements ProjectTrustPort {
  private levels = new Map<string, TrustLevel>();

  getTrust(cwd: string): Promise<ProjectTrustStatus> {
    const level = this.levels.get(cwd) ?? "untrusted";
    return Promise.resolve({ cwd, level });
  }

  isTrusted(cwd: string): Promise<boolean> {
    return Promise.resolve((this.levels.get(cwd) ?? "untrusted") === "trusted");
  }

  setTrust(cwd: string, level: TrustLevel): Promise<ProjectTrustStatus> {
    this.levels.set(cwd, level);
    return Promise.resolve({ cwd, level });
  }

  canReloadResources(cwd: string): Promise<TrustGateResult> {
    const level = this.levels.get(cwd) ?? "untrusted";
    return Promise.resolve({
      allowed: level === "trusted",
      level,
      ...(level === "trusted" ? {} : { reason: "project is not trusted" }),
    });
  }
}
