/**
 * pix agent runtime ports — the anti-corruption boundary against Pi
 * backends (currently the Pi SDK, later Pi RPC).
 *
 * These ports express what pix needs, never how a backend provides it.
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
import type { ProjectTrustState, ProjectTrustStatus, TrustGateResult } from "./trust.js";

/* ------------------------------------------------------------------ */
/* Project catalog context                                             */
/* ------------------------------------------------------------------ */

/**
 * Canonical project context for catalog reads.
 *
 * Carries the absolute working directory every project-scoped catalog read
 * applies to. Project-scoped reads (resources, trust) NEVER rely on an
 * implicit `process.cwd`; the canonical cwd is supplied explicitly via this
 * context at construction or per-call. Global catalogs (models, credentials)
 * are not project-scoped and ignore the cwd.
 */
export interface ProjectCatalogContext {
  /** Canonical absolute working directory; never resolved from process.cwd. */
  readonly cwd: string;
}

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

/**
 * Backend-neutral OFFLINE session mutation (rename). Kept as a separate,
 * narrowly-declared mutation contract so the read-only
 * {@link SessionCatalogPort} surface stays mutation-free for rename; the
 * catalog retains its existing deleteSession for backwards compatibility.
 * Backends (Pi SDK today, Pi RPC later) implement this port with no Pi
 * backend types crossing the boundary.
 */
export interface SessionMutationPort {
  /**
   * Rename an existing session by appending a session-info entry (never
   * rewrites the session header/file). Rejects with `not_found` for a missing
   * or stale id and NEVER creates a new session. Resolves once the new name
   * is committed and the read-side catalog observes it immediately.
   */
  renameSession(sessionId: string, name: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Model catalog (Host read side)                                      */
/* ------------------------------------------------------------------ */

/**
 * Read-only model catalog. Returns canonical {@link ModelInfo}/{@link ModelRef}
 * entries and the configured default; never returns a backend SDK Model
 * object and performs no network discovery/refresh/test/config writes.
 */
export interface ModelCatalogPort {
  listModels(): Promise<readonly ModelInfo[]>;
  /**
   * Configured default model, validated against the catalog and enabled scope,
   * falling back to the first enabled valid model, or null when none exist.
   */
  getDefaultModel(): Promise<ModelRef | null>;
  resolveModel(selector: ModelSelector): Promise<ModelInfo>;
}

/* ------------------------------------------------------------------ */
/* Credential catalog (Host read side) — provider metadata/status only */
/* ------------------------------------------------------------------ */

/**
 * Read-only credential/provider catalog. Exposes provider metadata and
 * sanitized configured/authorized status only; never returns raw API keys,
 * tokens, headers or any credential material, and never calls a
 * credential-returning/refresh backend API. Mutations (authorize/logout)
 * live on the separate {@link CredentialStorePort}.
 */
export interface CredentialCatalogPort {
  listProviders(): Promise<readonly AuthProviderInfo[]>;
  getProviderStatus(providerId: string): Promise<AuthProviderStatus>;
  isConfigured(providerId: string): Promise<boolean>;
}

/**
 * Credential store (Host) — extends the read-only catalog with credential
 * mutations. Credentials flow in one direction only: they are consumed by the
 * backend and never returned by any port method.
 */
export interface CredentialStorePort extends CredentialCatalogPort {
  /** Consumes credentials; only authorization state is ever returned. */
  authorize(providerId: string, input: AuthInput): Promise<AuthResult>;
  logout(providerId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Resource catalog (Host read side): skills / plugins / commands      */
/* ------------------------------------------------------------------ */

/**
 * Read-only resource catalog. Returns canonical skill/plugin/command
 * metadata only. Project-local resources are gated by project trust at the
 * caller (see {@link ProjectTrustQueryPort}); unknown/denied projects must
 * withhold project-local resources. No install/update/toggle/reload/write —
 * those mutations live on {@link ResourceCatalogStorePort}.
 */
export interface ResourceCatalogPort {
  listSkills(): Promise<readonly SkillInfo[]>;
  listPlugins(): Promise<readonly PluginInfo[]>;
  listCommands(): Promise<readonly SlashCommandInfo[]>;
}

/**
 * Resource catalog store (Host) — extends the read-only catalog with resource
 * mutations (write/toggle/install/update/reload). Kept as a separate, declared
 * mutation contract; there is no combined cross-domain writable factory.
 */
export interface ResourceCatalogStorePort extends ResourceCatalogPort {
  writePlugin(input: PluginWriteInput): Promise<PluginInfo>;
  setPluginEnabled(name: string, enabled: boolean): Promise<PluginInfo>;
  installSkill(input: SkillInstallInput): Promise<SkillInfo>;
  updateSkill(name: string): Promise<SkillInfo>;
  setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo>;
  /** Reload skills/plugins/tools (subject to project trust at the caller). */
  reload(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Project trust query (Host read side)                                */
/* ------------------------------------------------------------------ */

/**
 * Read-only project-trust query. Returns the exact tri-state
 * {@link ProjectTrustState} and gates resource reloads by trust. Queries are
 * project-scoped and always take an explicit `cwd`; no write/mutation.
 */
export interface ProjectTrustQueryPort {
  getProjectTrustState(cwd: string): Promise<ProjectTrustState>;
  isTrusted(cwd: string): Promise<boolean>;
  /** Whether loading/reloading resources for `cwd` is allowed. */
  canReloadResources(cwd: string): Promise<TrustGateResult>;
}

/**
 * Project trust (Host) — extends the read-only query with the trust-mutation
 * method. Kept as a separate, declared mutation contract; there is no combined
 * cross-domain writable factory.
 */
export interface ProjectTrustPort extends ProjectTrustQueryPort {
  getTrust(cwd: string): Promise<ProjectTrustStatus>;
  setTrust(cwd: string, level: ProjectTrustState): Promise<ProjectTrustStatus>;
}

/* ------------------------------------------------------------------ */
/* Convenience re-exports used across the port surface                 */
/* ------------------------------------------------------------------ */

export type { RuntimeCommand, RuntimeCommandType, RuntimeEvent, RuntimeError };
