/**
 * Canonical resource DTOs for {@link ResourceCatalogPort} and the runtime's
 * tool/command state. Skills, plugins and slash commands are normalized here;
 * backend package types never cross this boundary.
 */

export interface ToolInfo {
  name: string;
  description?: string;
  /** Whether the tool is currently active in the runtime. */
  active: boolean;
}

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: SlashCommandSource;
  sourceInfo?: unknown;
}

export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  version?: string;
  updateAvailable?: boolean;
}

export interface PluginInfo {
  name: string;
  version?: string;
  enabled: boolean;
}

export interface PluginWriteInput {
  name: string;
  content: string;
  enabled?: boolean;
}

export interface SkillInstallInput {
  source: string;
  name?: string;
}
