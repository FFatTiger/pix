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

/** Writable global settings.json authority. */
export interface SettingsConfigStorePort {
  readConfig(): Promise<SettingsConfigSnapshot>;
  writeConfig(input: SettingsConfigMutation): Promise<SettingsConfigSnapshot>;
  /** Structured read of the global tool selection (see {@link ToolSettingsSnapshot}). */
  readToolsConfig(): Promise<ToolSettingsSnapshot>;
  /** Structured CAS write of the global tool selection. */
  writeToolsConfig(input: ToolSettingsMutation): Promise<ToolSettingsSnapshot>;
}
