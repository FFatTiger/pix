/**
 * Settings dialog page ids, shared by the settings nav (SettingsModal) and
 * capability catalog detail-page links. The catalog declares detail pages as
 * plain strings (Protocol projection); features/settings maps them onto this
 * vocabulary.
 */
export type SettingsPageId =
  | "appearance"
  | "input"
  | "archive"
  | "providers"
  | "capabilities"
  | "memory"
  | "mcp"
  | "subagents"
  | "tools"
  | "compaction"
  | "session"
  | "skills"
  | "plugins"
  | "access"
  | "advanced"
  | "about";
