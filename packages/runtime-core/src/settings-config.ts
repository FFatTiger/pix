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

/** Writable global settings.json authority. */
export interface SettingsConfigStorePort {
  readConfig(): Promise<SettingsConfigSnapshot>;
  writeConfig(input: SettingsConfigMutation): Promise<SettingsConfigSnapshot>;
}
