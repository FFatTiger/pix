/**
 * Pi-web agent runtime ports — the anti-corruption boundary against Pi
 * backends (currently the Pi SDK, later Pi RPC).
 *
 * These ports express what pi-web needs, never how a backend provides it.
 * No backend session, manager, SDK model/event/error or RPC method/frame
 * type appears in this surface.
 */
import type { RuntimeCapabilitySet } from "./capabilities.js";
import type { AuthInput, AuthProviderInfo, AuthProviderStatus, AuthResult } from "./auth.js";
import type { RuntimeCommand, RuntimeCommandType } from "./commands.js";
import type { RuntimeEvent } from "./events.js";
import type { RuntimeError } from "./errors.js";
import type { RuntimeCloseReason, RuntimeIdentity } from "./identity.js";
import type { RuntimeInterrupt, RuntimeInterruptResult } from "./interrupt.js";
import type { ModelInfo, ModelRef, ModelSelector } from "./model.js";
import type { ThinkingLevel } from "./messages.js";
import type { RuntimeCommandResult } from "./result.js";
import type {
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
} from "./session.js";
import type { RuntimeSnapshot } from "./state.js";
import type { PluginInfo, PluginWriteInput, SkillInfo, SkillInstallInput, SlashCommandInfo } from "./resources.js";
import type { ProjectTrustStatus, TrustGateResult, TrustLevel } from "./trust.js";

/* ------------------------------------------------------------------ */
/* Agent runtime                                                       */
/* ------------------------------------------------------------------ */

/** Inputs for creating a brand-new session (a new JSONL). */
export interface RuntimeStartInput {
  /** Working directory the agent runs in. */
  cwd: string;
  /** Initial model selection; backend default applies when omitted. */
  model?: ModelSelector;
  /** Initial tool set; backend default applies when omitted. */
  toolNames?: readonly string[];
  /** Initial thinking selection; backend default applies when omitted. */
  thinkingLevel?: ThinkingLevel;
  /** Pin the selection so model changes/reloads must preserve it. */
  thinkingLevelPinned?: boolean;
  /** Initial session name. */
  name?: string;
}

/** Inputs for opening an existing session (resume / re-activate). */
export interface RuntimeOpenInput {
  sessionId: string;
  cwd?: string;
  model?: ModelSelector;
}

/**
 * A single-session agent runtime. One port instance backs exactly one
 * session (D-004).
 */
export interface AgentRuntimePort {
  readonly identity: RuntimeIdentity;

  /** Current capability snapshot; may change after reload. */
  getCapabilities(): RuntimeCapabilitySet;

  /** Full recoverable state for attach/resume. */
  getSnapshot(): Promise<RuntimeSnapshot>;

  /**
   * Subscribe to normalized runtime events. Returns an unsubscribe function.
   */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;

  /**
   * Execute a product command. Resolves with a typed result when the command
   * has settled; never rejects with backend errors — failures are structured
   * {@link RuntimeError} results.
   */
  execute(command: RuntimeCommand): Promise<RuntimeCommandResult>;

  /**
   * Independent control channel: abort-family operations are never blocked
   * behind long-running prompt/bash/compact work and are idempotent. Capability
   * failures are returned as structured canonical results before state changes.
   */
  interrupt(interrupt: RuntimeInterrupt): Promise<RuntimeInterruptResult>;

  /**
   * End the runtime with a canonical reason. Idempotent: calling close twice
   * resolves without error. After close the port reports `unavailable`.
   */
  close(reason: RuntimeCloseReason): Promise<void>;
}

/**
 * Creates or opens runtimes. Factory methods throw a structured
 * {@link RuntimeError} on failure (e.g. `not_found` when opening a missing
 * session). The factory is the composition boundary where the adapter
 * implementation is injected.
 */
export interface AgentRuntimeFactory {
  create(input: RuntimeStartInput): Promise<AgentRuntimePort>;
  open(input: RuntimeOpenInput): Promise<AgentRuntimePort>;
}

/* ------------------------------------------------------------------ */
/* Session catalog / locator (Host read side + sessiond activation)    */
/* ------------------------------------------------------------------ */

/** Read-side session browsing (Host): list / read / context. */
export interface SessionCatalogPort {
  listSessions(filter?: SessionListFilter): Promise<readonly SessionHeader[]>;
  readSession(sessionId: string): Promise<SessionDetail>;
  readSessionContext(
    sessionId: string,
    options?: { leafId?: string },
  ): Promise<SessionContext>;
  deleteSession(sessionId: string): Promise<void>;
}

/** Activation-side session resolution (sessiond / worker shell). */
export interface SessionLocatorPort {
  /** Resolve the canonical session file for activation. */
  locate(sessionId: string): Promise<SessionLocation>;
  /** Resolve the active leaf (branch) of a session. */
  resolveLeafId(sessionId: string, targetId?: string): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Model catalog (Host)                                                */
/* ------------------------------------------------------------------ */

export interface ModelCatalogPort {
  listModels(): Promise<readonly ModelInfo[]>;
  getDefaultModel(): Promise<ModelRef>;
  resolveModel(selector: ModelSelector): Promise<ModelInfo>;
}

/* ------------------------------------------------------------------ */
/* Credential store (Host) — never exposes raw credentials             */
/* ------------------------------------------------------------------ */

export interface CredentialStorePort {
  listProviders(): Promise<readonly AuthProviderInfo[]>;
  getProviderStatus(providerId: string): Promise<AuthProviderStatus>;
  isConfigured(providerId: string): Promise<boolean>;
  /** Consumes credentials; only authorization state is ever returned. */
  authorize(providerId: string, input: AuthInput): Promise<AuthResult>;
  logout(providerId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Resource catalog (Host): skills / plugins / commands                */
/* ------------------------------------------------------------------ */

export interface ResourceCatalogPort {
  listSkills(): Promise<readonly SkillInfo[]>;
  listPlugins(): Promise<readonly PluginInfo[]>;
  listCommands(): Promise<readonly SlashCommandInfo[]>;
  writePlugin(input: PluginWriteInput): Promise<PluginInfo>;
  setPluginEnabled(name: string, enabled: boolean): Promise<PluginInfo>;
  installSkill(input: SkillInstallInput): Promise<SkillInfo>;
  updateSkill(name: string): Promise<SkillInfo>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo>;
  /** Reload skills/plugins/tools (subject to project trust at the caller). */
  reload(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Project trust (Host): trust + resource-reload boundary              */
/* ------------------------------------------------------------------ */

export interface ProjectTrustPort {
  getTrust(cwd: string): Promise<ProjectTrustStatus>;
  isTrusted(cwd: string): Promise<boolean>;
  setTrust(cwd: string, level: TrustLevel): Promise<ProjectTrustStatus>;
  /** Whether loading/reloading resources for `cwd` is allowed. */
  canReloadResources(cwd: string): Promise<TrustGateResult>;
}

/* ------------------------------------------------------------------ */
/* Convenience re-exports used across the port surface                 */
/* ------------------------------------------------------------------ */

export type { RuntimeCommand, RuntimeCommandType, RuntimeEvent, RuntimeError };
