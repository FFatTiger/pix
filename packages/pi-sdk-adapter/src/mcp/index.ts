// Public MCP settings surface of the pix Pi SDK Adapter.
//
// The ONE place Pix touches the standalone MCP client library or the global
// `<agentDir>/mcp.json` document: listing/editing/probing Pi's own MCP server
// config for the Pix settings "MCP" page. The runtime seam is intentionally
// narrow and mirrors the other agent-dir config surfaces (models / settings /
// memory): a missing file is an empty list, malformed files fail closed, and
// literal env/header secrets never cross this boundary (write-only, exactly
// like the Lore token).
import type {
  McpEnabledMutation,
  McpImportPreview,
  McpImportRequest,
  McpProbeRequest,
  McpServerWrite,
  McpSettingsSnapshot,
} from "@fffattiger/pix-runtime-core";
import { createMcpSettingsStore } from "../internal/mcp-settings-store.js";

export interface PiSdkMcpSettingsConfig {
  /** Full settings snapshot (config + cached probe results; no secrets). */
  readSettings(): Promise<McpSettingsSnapshot>;
  /** Create/replace one server from the form editor. */
  upsertServer(input: McpServerWrite): Promise<McpSettingsSnapshot>;
  /** Enable/disable one server (enabled:false is explicit in mcp.json). */
  setEnabled(name: string, input: McpEnabledMutation): Promise<McpSettingsSnapshot>;
  removeServer(name: string): Promise<McpSettingsSnapshot>;
  /** Validate pasted JSON and report what an import would do (no write). */
  importPreview(input: McpImportRequest): Promise<McpImportPreview>;
  /** Import pasted JSON; all-or-nothing (any invalid entry rejects the write). */
  importServers(input: McpImportRequest): Promise<McpSettingsSnapshot>;
  /** Probe one server (30s cache; `refresh` forces a reconnect). */
  testServer(name: string, input: McpProbeRequest): Promise<McpSettingsSnapshot>;
}

/** Create the MCP settings authority for the settings "MCP" page. */
export function createPiSdkMcpSettingsConfig(
  options: { agentDir: string; env?: NodeJS.ProcessEnv; now?: () => number },
): PiSdkMcpSettingsConfig {
  const store = createMcpSettingsStore(options);
  return {
    readSettings: () => store.readSettings(),
    upsertServer: (input) => store.upsertServer(input),
    setEnabled: (name, input) => store.setEnabled(name, input.enabled),
    removeServer: (name) => store.removeServer(name),
    importPreview: (input) => store.importPreview(input),
    importServers: (input) => store.importServers(input),
    testServer: (name, input) => store.testServer(name, input.refresh),
  };
}
