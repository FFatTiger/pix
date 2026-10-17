/**
 * Canonical MCP settings models (Pix settings "MCP" page).
 *
 * The on-disk truth is Pi's own global `<agentDir>/mcp.json` (SDK 1.3
 * `builtin:mcp` extension reads it at session start). Pix never re-implements
 * the connect semantics: it lists/edits/probes the same document. Protocol
 * mirrors these shapes (`packages/protocol/src/mcp-settings.ts`) because it
 * cannot import runtime-core; cross-package contract tests pin the copies.
 *
 * Secret rule: `env` / `headers` VALUES are write-only exactly like the Lore
 * token. A `${VAR}` reference or a whole-value `!command` is not a secret (the
 * value never contains it), so it round-trips verbatim; a literal value never
 * leaves the adapter — its projection is `{ redacted: true }` and an edit that
 * omits the key keeps the stored literal.
 */

/** Server transport kinds Pix edits. `streamable-http` normalizes to `http`; `sse` is invalid. */
export type McpServerKind = "stdio" | "http";

export const MCP_SERVER_KINDS: readonly McpServerKind[] = ["stdio", "http"];

/**
 * Projection of one `env`/`headers` value: `!command` and `${VAR}` references
 * pass through verbatim (they contain no secret); literals are redacted.
 */
export type McpSecretValue = { redacted: true } | { redacted: false; value: string };

/** One tool reported by a successful probe (`initialize` → `tools/list`). */
export interface McpToolInfo {
  name: string;
  description: string;
}

/**
 * Outcome states of a connection probe. `unknown` = no fresh probe result
 * (never probed, or the config changed since); `disabled` is derived from the
 * entry and never probed. `needs_auth` = HTTP 401 / McpAuthRequiredError.
 */
export type McpProbeState = "connected" | "needs_auth" | "failed" | "disabled" | "unknown";

export const MCP_PROBE_STATES: readonly McpProbeState[] = [
  "connected",
  "needs_auth",
  "failed",
  "disabled",
  "unknown",
];

/** Cached probe result for one server (sanitized: no secrets in error/stderr). */
export interface McpProbeStatus {
  state: McpProbeState;
  tools: readonly McpToolInfo[];
  /** Sanitized, truncated first line of the failure reason (null otherwise). */
  error: string | null;
  /** Last stderr lines of a failed stdio server (sanitized, max 20). */
  stderrTail: readonly string[];
  /** Epoch ms of the probe that produced this result; null for derived states. */
  probedAt: number | null;
}

/**
 * One `mcpServers` entry as shown in the UI. Invalid entries are LISTED with
 * their reason (never silently dropped, matching `pi mcp list`); their fields
 * are null and they cannot be edited — only deleted or replaced wholesale.
 */
export interface McpServerSnapshot {
  name: string;
  valid: boolean;
  /** Fixed English reason string for an invalid entry (null when valid). */
  invalidReason: string | null;
  kind: McpServerKind | null;
  enabled: boolean;
  command: string | null;
  args: readonly string[] | null;
  env: Readonly<Record<string, McpSecretValue>> | null;
  cwd: string | null;
  url: string | null;
  headers: Readonly<Record<string, McpSecretValue>> | null;
  /** Per-request timeout in seconds (SDK default 60). */
  timeout: number | null;
  description: string | null;
  status: McpProbeStatus;
}

/** Full settings GET projection: every global server + its cached probe. */
export interface McpSettingsSnapshot {
  servers: readonly McpServerSnapshot[];
}

/** Per-key env/headers write intent (mirrors the models.json apiKey modes). */
export type McpSecretMutation =
  | { mode: "preserve" }
  | { mode: "remove" }
  | { mode: "replace"; value: string };

/** Create-or-replace write of one server (form editor payload). */
export interface McpServerWrite {
  name: string;
  kind: McpServerKind;
  /** stdio: required; http: must be absent. One executable, not a shell line. */
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, McpSecretMutation>>;
  cwd?: string;
  /** http: required; stdio: must be absent. */
  url?: string;
  headers?: Readonly<Record<string, McpSecretMutation>>;
  timeout?: number;
  description?: string;
}

/** One parsed paste-import entry (validation outcome, no secrets). */
export interface McpImportPreviewEntry {
  name: string;
  valid: boolean;
  invalidReason: string | null;
  /** True when an existing server with the exact same name is replaced. */
  overwrite: boolean;
  kind: McpServerKind | null;
}

/** Paste-import preview (no write happened). */
export interface McpImportPreview {
  entries: readonly McpImportPreviewEntry[];
}

/** Request bodies for the paste-import routes: the raw JSON text as pasted. */
export interface McpImportRequest {
  json: string;
}

/** Enabled-toggle body (`PATCH /v1/settings/mcp/servers/:name`). */
export interface McpEnabledMutation {
  enabled: boolean;
}

/** Probe request body: `refresh: true` bypasses the 30s cache (test button). */
export interface McpProbeRequest {
  refresh: boolean;
}
