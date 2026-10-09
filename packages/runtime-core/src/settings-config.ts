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
}
