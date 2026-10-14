import { THINKING_LEVELS, type ThinkingLevel } from "./messages.js";

/**
 * Canonical editable global settings.json projection.
 *
 * The editor is a raw-text round trip: pix never interprets or rewrites the
 * user's file. `content` is the exact source text (comments and formatting
 * preserved); `revision` is the SHA-256 of those bytes and acts as the
 * optimistic compare-and-swap fence, mirroring the models.json editor.
 */

export interface SettingsConfigSnapshot {
  /** SHA-256 of the exact source bytes; empty string when the file is absent. */
  revision: string;
  /** Raw file text. Empty string when settings.json does not exist yet. */
  content: string;
}

export interface SettingsConfigMutation {
  expectedRevision: string;
  /** Full replacement text. Validated (loose JSON object) before publishing. */
  content: string;
}

/**
 * How Pix selects the tools offered to new sessions.
 *
 * - `all`: every registered tool that can be declared to the model
 *   (`direct`/`model-only` exposure, including codemode/tool_search). Tools
 *   added in the future are enabled automatically.
 * - `custom`: exactly the persisted allowlist. Unknown/not-currently-loaded
 *   names stay persisted but simply do not apply.
 * - `native`: the Pi `settings.json` `defaultTools` selection (including
 *   `+`/`-` modifiers) is authoritative; Pix adds nothing on top.
 */
export type ToolsSelection =
  | { mode: "all" }
  | { mode: "custom"; toolNames: readonly string[] }
  | { mode: "native"; toolNames: readonly string[] };

/** Global tool-selection snapshot (`pixDefaultTools` in settings.json). */
export interface ToolSettingsSnapshot {
  /** SHA-256 of the exact settings.json bytes; empty-file digest when absent. */
  revision: string;
  selection: ToolsSelection;
}

/**
 * CAS write of the global tool selection.
 *
 * `toolNames` semantics mirror the persisted `pixDefaultTools` key:
 * `null` = enable all (the Pix default), an array (possibly empty = all
 * off) = the explicit allowlist. The native `defaultTools` key is never
 * rewritten by this mutation.
 */
export interface ToolSettingsMutation {
  expectedRevision: string;
  toolNames: readonly string[] | null;
}

/** Exact native role name; model strings may be provider-qualified or fuzzy. */
export interface SubagentAgentOverride {
  name: string;
  model: string | null;
  fallbackModel: string | null;
  thinking: ThinkingLevel | null;
}

/**
 * Global subagent configuration only; no current runtime or project resolution.
 * All fields are required. Null clears the corresponding native override.
 * Adapters merge role rows by exact name and preserve omitted roles and unknown
 * native metadata. Metadata-only native roles project as rows with null fields.
 */
export interface SubagentSettings {
  defaultModel: string | null;
  fallbackModel: string | null;
  agentOverrides: readonly SubagentAgentOverride[];
}

export interface SubagentSettingsSnapshot {
  /** SHA-256 of the exact settings.json bytes; empty-file digest when absent. */
  revision: string;
  settings: SubagentSettings;
}

export interface SubagentSettingsMutation {
  expectedRevision: string;
  settings: SubagentSettings;
}

/** Validate the strict editable DTO, preserving role identity and trimming models. */
export function normalizeSubagentSettings(value: unknown): SubagentSettings | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("defaultModel") || !keys.includes("fallbackModel") || !keys.includes("agentOverrides")) return null;
  const input = value as { defaultModel: unknown; fallbackModel: unknown; agentOverrides: unknown };
  const defaultModel = normalizeSubagentModel(input.defaultModel);
  const fallbackModel = normalizeSubagentModel(input.fallbackModel);
  if (defaultModel === undefined || fallbackModel === undefined || !Array.isArray(input.agentOverrides)) return null;
  const names = new Set<string>();
  const agentOverrides: SubagentAgentOverride[] = [];
  for (const item of input.agentOverrides) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const rowKeys = Object.keys(item);
    if (rowKeys.length !== 4 || !rowKeys.includes("name") || !rowKeys.includes("model") || !rowKeys.includes("fallbackModel") || !rowKeys.includes("thinking")) return null;
    const row = item as { name: unknown; model: unknown; fallbackModel: unknown; thinking: unknown };
    if (typeof row.name !== "string" || row.name.trim().length === 0 || names.has(row.name)) return null;
    const model = normalizeSubagentModel(row.model);
    const rowFallbackModel = normalizeSubagentModel(row.fallbackModel);
    if (model === undefined || rowFallbackModel === undefined) return null;
    if (row.thinking !== null && (typeof row.thinking !== "string" || !THINKING_LEVELS.includes(row.thinking as ThinkingLevel))) return null;
    names.add(row.name);
    agentOverrides.push({ name: row.name, model, fallbackModel: rowFallbackModel, thinking: row.thinking as ThinkingLevel | null });
  }
  return { defaultModel, fallbackModel, agentOverrides };
}

function normalizeSubagentModel(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Writable global settings.json authority. */
export interface SettingsConfigStorePort {
  readConfig(): Promise<SettingsConfigSnapshot>;
  writeConfig(input: SettingsConfigMutation): Promise<SettingsConfigSnapshot>;
  /** Structured read of the global tool selection (see {@link ToolSettingsSnapshot}). */
  readToolsConfig(): Promise<ToolSettingsSnapshot>;
  /** Structured CAS write of the global tool selection. */
  writeToolsConfig(input: ToolSettingsMutation): Promise<ToolSettingsSnapshot>;
  /** Structured global subagent configuration, independent of any session. */
  readSubagentConfig(): Promise<SubagentSettingsSnapshot>;
  /** Structured CAS write; nullable fields clear native overrides. */
  writeSubagentConfig(input: SubagentSettingsMutation): Promise<SubagentSettingsSnapshot>;
  /**
   * Structured read of the context-compaction objects (`compaction` +
   * `smartCompact`); absent keys read as the documented defaults.
   */
  readCompactionConfig(): Promise<CompactionSettingsSnapshot>;
  /** Structured CAS write; nullable fields clear the persisted overrides. */
  writeCompactionConfig(input: CompactionSettingsMutation): Promise<CompactionSettingsSnapshot>;
  /** Structured read of the long-term memory provider (`pixMemoryProvider`). */
  readMemoryConfig(): Promise<MemorySettingsSnapshot>;
  /** Structured CAS write of the memory provider (lore requires a connection). */
  writeMemoryProvider(input: MemoryProviderMutation): Promise<MemorySettingsSnapshot>;
}

// ---------------------------------------------------------------------------
// Context compaction (settings.json `compaction` + `smartCompact` objects)
// ---------------------------------------------------------------------------

/** pi-smart-compact compression styles (plugin VALID_PROFILES, pinned 10.3.0). */
export type SmartCompactProfile = "light" | "balanced" | "aggressive";

/** Plugin thinking levels (no "off": compaction always reasons at least minimally). */
export type SmartCompactThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const SMART_COMPACT_PROFILES: readonly SmartCompactProfile[] = ["light", "balanced", "aggressive"];
export const SMART_COMPACT_THINKING_LEVELS: readonly SmartCompactThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Pi native auto-compaction (`compaction` object). Null clears the override. */
export interface NativeCompactionSettings {
  /**
   * `compaction.enabled`. Pix always runs Pi's built-in auto-compaction as the
   * fallback, so this is forced true on read and on write — a stored `false`
   * is treated as on and the next structured save persists `true`. There is no
   * user switch for it.
   */
  enabled: boolean;
  /** `compaction.reserveTokens` — tokens reserved after native compaction. */
  reserveTokens: number | null;
  /** `compaction.keepRecentTokens` — recent tokens kept verbatim. */
  keepRecentTokens: number | null;
}

/**
 * The page-managed subset of the plugin's `smartCompact` object. The plugin's
 * on/off lives in pix-builtins.json (capability), NOT here. Null model/thinking
 * clears the override (plugin default: follow the session model / "minimal").
 */
export interface SmartCompactSettings {
  autoTrigger: boolean;
  minContextPercent: number;
  profile: SmartCompactProfile;
  summaryModel: string | null;
  segmentationModel: string | null;
  summaryThinkingLevel: SmartCompactThinkingLevel | null;
  segmentationThinkingLevel: SmartCompactThinkingLevel | null;
  autoTriggerTimeoutMs: number;
  backupEnabled: boolean;
  scrubSecrets: boolean;
  focusWeighting: boolean;
  onlineDamageMonitor: boolean;
  adaptiveDamageFeedback: boolean;
}

export interface CompactionSettings {
  native: NativeCompactionSettings;
  smart: SmartCompactSettings;
}

export interface CompactionSettingsSnapshot {
  /** SHA-256 of the exact settings.json bytes; empty-file digest when absent. */
  revision: string;
  settings: CompactionSettings;
}

export interface CompactionSettingsMutation {
  expectedRevision: string;
  settings: CompactionSettings;
}

// ---------------------------------------------------------------------------
// Long-term memory provider (settings.json `pixMemoryProvider`)
// ---------------------------------------------------------------------------

/**
 * Which long-term memory backend Pix loads for sessions. Exactly one of the
 * two bundled memory plugins (pi-memory / Lore) may load; `"off"` loads
 * neither. Canonical owner: the Pix settings "记忆" page — never a per
 * capability toggle.
 */
export type MemoryProvider = "local" | "lore" | "off";

export const MEMORY_PROVIDERS: readonly MemoryProvider[] = ["local", "lore", "off"];

/**
 * Normalize a persisted `pixMemoryProvider` value. Returns the provider when
 * valid, `undefined` when the key is absent, and `null` when present but
 * invalid (callers fail closed on `null`, never silently re-default).
 */
export function normalizeMemoryProviderValue(value: unknown): MemoryProvider | undefined | null {
  if (value === undefined) return undefined;
  return MEMORY_PROVIDERS.includes(value as MemoryProvider) ? value as MemoryProvider : null;
}

/**
 * Effective-provider resolution: an explicit `pixMemoryProvider` wins; when
 * the key is absent, a machine that already carries a configured Lore
 * connection (~/.lore/config.json or LORE_* env) defaults to Lore so an
 * existing Lore user is never silently switched to local memory; everyone
 * else defaults to the bundled local memory.
 */
export function effectiveMemoryProvider(
  explicit: MemoryProvider | undefined,
  loreConfigured: boolean,
): MemoryProvider {
  if (explicit !== undefined) return explicit;
  return loreConfigured ? "lore" : "local";
}

/** Lore connection facts as the settings page sees them (no secrets). */
export interface LoreConnectionSnapshot {
  /** Both a base URL and a token are available (file or env). */
  configured: boolean;
  /** Effective base URL (file wins over env); null when neither is set. */
  baseUrl: string | null;
  /** Where the effective base URL came from. */
  source: "config" | "env" | "none";
  /** A token is present in the same source (never the token itself). */
  tokenConfigured: boolean;
}

export interface MemorySettingsSnapshot {
  /** SHA-256 of the exact settings.json bytes; empty-file digest when absent. */
  revision: string;
  /** Effective provider (explicit value, or the migration default). */
  provider: MemoryProvider;
  /** Whether `pixMemoryProvider` is explicitly persisted in settings.json. */
  providerExplicit: boolean;
  lore: LoreConnectionSnapshot;
}

export interface MemoryProviderMutation {
  expectedRevision: string;
  provider: MemoryProvider;
}

/**
 * CAS write of the memory provider (`pixMemoryProvider`). Enabling `"lore"`
 * requires a configured Lore connection first (adapters enforce it; the UI
 * additionally gates on a passing connection test).
 */
export interface LoreConnectionMutation {
  /** Absolute http(s) base URL of the Lore server. */
  baseUrl: string;
  /**
   * Write-only API token. Omitted = keep the saved token when the base URL
   * is unchanged; changing the base URL without a token clears the old one
   * (mirrors the official @loremem/cli semantics).
   */
  apiToken?: string;
}

/** "Test connection" outcome against `GET <base>/api/health`. */
export type LoreTestOutcome =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: "invalid_url" | "insecure_http" | "missing_token" | "unauthorized" | "unreachable" };

export interface LoreTestRequest {
  /** Defaults to the effective base URL (config file, then env). */
  baseUrl?: string;
  /** Defaults to the saved token (config file, then env). */
  apiToken?: string;
}

function normalizeCompactionModel(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeCompactionThinking(value: unknown): SmartCompactThinkingLevel | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && SMART_COMPACT_THINKING_LEVELS.includes(value as SmartCompactThinkingLevel)
    ? value as SmartCompactThinkingLevel
    : undefined;
}

function normalizeCompactionTokens(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Validate the strict editable compaction DTO. All fields required (missing
 * keys read as the documented defaults before reaching the UI); nullable
 * fields clear the persisted override. Returns null on any malformed value.
 */
export function normalizeCompactionSettings(value: unknown): CompactionSettings | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as { native?: unknown; smart?: unknown };
  if (input.native === null || typeof input.native !== "object" || Array.isArray(input.native)) return null;
  if (input.smart === null || typeof input.smart !== "object" || Array.isArray(input.smart)) return null;
  const native = input.native as Record<string, unknown>;
  const smart = input.smart as Record<string, unknown>;
  if (typeof native.enabled !== "boolean") return null;
  const reserveTokens = normalizeCompactionTokens(native.reserveTokens);
  const keepRecentTokens = normalizeCompactionTokens(native.keepRecentTokens);
  if (reserveTokens === undefined || keepRecentTokens === undefined) return null;
  if (typeof smart.autoTrigger !== "boolean"
    || typeof smart.backupEnabled !== "boolean"
    || typeof smart.scrubSecrets !== "boolean"
    || typeof smart.focusWeighting !== "boolean"
    || typeof smart.onlineDamageMonitor !== "boolean"
    || typeof smart.adaptiveDamageFeedback !== "boolean") return null;
  if (typeof smart.minContextPercent !== "number"
    || !Number.isFinite(smart.minContextPercent)
    || smart.minContextPercent < 0 || smart.minContextPercent > 100) return null;
  if (typeof smart.autoTriggerTimeoutMs !== "number"
    || !Number.isSafeInteger(smart.autoTriggerTimeoutMs)
    || smart.autoTriggerTimeoutMs < 1000 || smart.autoTriggerTimeoutMs > 300000) return null;
  if (typeof smart.profile !== "string" || !SMART_COMPACT_PROFILES.includes(smart.profile as SmartCompactProfile)) return null;
  const summaryModel = normalizeCompactionModel(smart.summaryModel);
  const segmentationModel = normalizeCompactionModel(smart.segmentationModel);
  const summaryThinkingLevel = normalizeCompactionThinking(smart.summaryThinkingLevel);
  const segmentationThinkingLevel = normalizeCompactionThinking(smart.segmentationThinkingLevel);
  if (summaryModel === undefined || segmentationModel === undefined
    || summaryThinkingLevel === undefined || segmentationThinkingLevel === undefined) return null;
  return {
    // Pi's own auto-compaction is the always-on fallback; never persist off.
    native: { enabled: true, reserveTokens, keepRecentTokens },
    smart: {
      autoTrigger: smart.autoTrigger,
      minContextPercent: smart.minContextPercent,
      profile: smart.profile as SmartCompactProfile,
      summaryModel,
      segmentationModel,
      summaryThinkingLevel,
      segmentationThinkingLevel,
      autoTriggerTimeoutMs: smart.autoTriggerTimeoutMs,
      backupEnabled: smart.backupEnabled,
      scrubSecrets: smart.scrubSecrets,
      focusWeighting: smart.focusWeighting,
      onlineDamageMonitor: smart.onlineDamageMonitor,
      adaptiveDamageFeedback: smart.adaptiveDamageFeedback,
    },
  };
}
