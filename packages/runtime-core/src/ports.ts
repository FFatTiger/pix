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
import type { RuntimeReadRequest, RuntimeReadResult } from "./reads.js";
import type { RuntimeError } from "./errors.js";
import type { RuntimeCloseReason, RuntimeIdentity } from "./identity.js";
import type { RuntimeInterrupt, RuntimeInterruptResult } from "./interrupt.js";
import type { ModelInfo, ModelRef, ModelSelector } from "./model.js";
import type { ThinkingLevel } from "./messages.js";
import type { RuntimeCommandResult } from "./result.js";
import type {
  CatalogPageRequest,
  ProjectPage,
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
  SessionPage,
  SessionPageRequest,
  SessionThinkingBlock,
  SessionTree,
} from "./session.js";
import type { RuntimeSnapshot } from "./state.js";
import type { RuntimeTurnHandle, RuntimeTurnStart } from "./turns.js";
import type { PluginInfo, PluginWriteInput, SkillInfo, SkillInstallInput, SlashCommandInfo } from "./resources.js";
import type { ResolvedTheme, ThemeSetInfo, ThemeVariant } from "./themes.js";
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
   * Atomically validate/apply activation overrides and admit exactly one prompt.
   * The returned handle separates quick admission from long-running completion.
   */
  submitTurn(input: RuntimeTurnStart): Promise<RuntimeTurnHandle>;

  /**
   * Perform a pure read over the runtime projection (Phase 2B independent read
   * RPC). Reads never mutate state, never consume the mutation at-most-once
   * admission ledger and stay available while a long prompt/bash/compact turn
   * is pending. Resolves with a typed result; failures are structured
   * {@link RuntimeError} results (never a thrown backend error).
   */
  read(request: RuntimeReadRequest): Promise<RuntimeReadResult>;

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

/** Read-side session browsing (Host): page / read / context / thinking / tree. */
export interface SessionCatalogPort {
  /**
   * Prepare the disposable materialized browse index. Production sessiond
   * calls this before advertising the catalog so page requests never trigger
   * directory scans. Test/in-memory adapters may omit it.
   */
  prepare?(): Promise<void>;
  /** True numbered session page. Filtering, totals and ordering precede slice. */
  listSessionPage?(request: SessionPageRequest): Promise<SessionPage>;
  /**
   * Legacy in-process full-list surface. Protocol v4 has no limit/offset API;
   * production Host browsing must use listSessionPage. Removal condition:
   * migrate remaining adapter contract/list-cache tests to page reads.
   */
  listSessions(filter?: SessionListFilter): Promise<readonly SessionHeader[]>;
  readSession(sessionId: string): Promise<SessionDetail>;
  /**
   * Selected-branch context read (zero workers). Options:
   * - `leafId` pins the branch (must be a member entry of THIS session);
   * - `before` is an exclusive stable projected entryId cursor;
   * - `limit` bounds the Protocol-v2 compatibility page. OMITTED `limit`
   *   returns the COMPLETE selected projected active branch
   *   (`hasMore === false`) — direct source-history parity. Remove the cursor
   *   options only after Protocol v3 minimum + visible-branch export migration;
   * - `deferThinking` projects assistant thinking blocks with non-empty text
   *   as empty `deferred` placeholders (resolved later by
   *   {@link SessionCatalogPort.readSessionThinking});
   * - `deferMedia` omits base64 images from toolResult messages, replacing
   *   them with one truthful summary per message (URL sources kept).
   */
  readSessionContext(
    sessionId: string,
    options?: {
      leafId?: string;
      before?: string;
      limit?: number;
      deferThinking?: boolean;
      deferMedia?: boolean;
    },
  ): Promise<SessionContext>;
  /**
   * Resolve one deferred thinking block by EXACT identity: `blockIndex`
   * indexes the same canonical projected assistant content array that a
   * deferred `readSessionContext` page carried. Fail-closed: missing
   * session/entry, a non-assistant entry, or a non-thinking block →
   * `not_found`; a malformed block index → `invalid_input`. Zero workers.
   */
  readSessionThinking(
    sessionId: string,
    entryId: string,
    blockIndex: number,
  ): Promise<SessionThinkingBlock>;
  /**
   * Normalized read-only branch tree of the whole session (BranchNavigator
   * slice). Pure persisted-JSONL projection — zero workers, zero activation;
   * `currentLeafId` is the persisted catalog head, never the live worker
   * leaf (see {@link SessionTree}).
   */
  readSessionTree(sessionId: string): Promise<SessionTree>;
  deleteSession(sessionId: string): Promise<void>;
}

/** Independent project catalog over the same materialized session index. */
export interface ProjectCatalogPort {
  prepare?(): Promise<void>;
  listProjectPage(request: CatalogPageRequest): Promise<ProjectPage>;
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
/* Theme catalog (Host read side): theme sets + resolved CSS vars      */
/* ------------------------------------------------------------------ */

/**
 * Read-only theme catalog. Lists theme sets (agent-dir global themes,
 * trusted project `.pi/themes`, plus the built-in registry) and resolves one
 * variant of a set into the fixed whitelisted CSS custom properties.
 *
 * Project-scoped reads take an optional canonical `cwd`; the caller gates the
 * cwd by project trust BEFORE the read (untrusted projects contribute no
 * project-local themes — the same resource-security principle as
 * {@link ResourceCatalogPort}). No write/reload: themes are immutable data.
 *
 * `resolveTheme` rejects with a structured {@link RuntimeError} (`not_found`)
 * when no user theme, project theme or built-in matches; malformed names
 * reject with `invalid_input` before any filesystem access.
 */
export interface ThemeCatalogPort {
  /** All available theme sets for the (optional) project cwd. */
  listThemeSets(cwd?: string): Promise<readonly ThemeSetInfo[]>;
  /** Resolve one variant of a theme set into whitelisted CSS variables. */
  resolveTheme(name: string, mode: ThemeVariant, cwd?: string): Promise<ResolvedTheme>;
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
 * Project trust (Host) — the trust-mutation contract. A SEPARATE, narrow
 * mutation port (the session-rename precedent): it carries ONLY the
 * set-trusted mutation and deliberately does NOT extend
 * {@link ProjectTrustQueryPort}, so no mutation method can ever leak onto the
 * read-only query surface and a query port object can never serve as a
 * mutation port. There is no combined cross-domain writable factory.
 *
 * This slice records an explicit "trusted" decision only. `denied` writes are
 * NOT part of the contract: the SDK trust vocabulary supports a persisted
 * `false` decision, but no pix surface needs it yet, so the port stays a
 * single-method, single-level contract (strictly enumerable if ever needed).
 */
export interface ProjectTrustMutationPort {
  /**
   * Record an explicit "trusted" decision for the project at the canonical
   * `cwd` and return the strict post-write trust status (read-after-write).
   */
  setProjectTrusted(cwd: string): Promise<ProjectTrustStatus>;
}

/* ------------------------------------------------------------------ */
/* Convenience re-exports used across the port surface                 */
/* ------------------------------------------------------------------ */

export type { RuntimeCommand, RuntimeCommandType, RuntimeEvent, RuntimeError };
