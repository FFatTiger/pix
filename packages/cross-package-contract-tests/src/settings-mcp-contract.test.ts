/**
 * Cross-package MCP settings contract — Protocol wire projection vs the
 * runtime-core canonical models. Protocol cannot import runtime-core; these
 * tests pin vocabularies and snapshot/write shapes by semantic equality, and
 * prove the secret rule (literal env/header values can never ride the wire).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_PROBE_STATES as CANONICAL_PROBE_STATES,
  MCP_SERVER_KINDS as CANONICAL_KINDS,
  type McpEnabledMutation,
  type McpImportPreview,
  type McpImportRequest,
  type McpProbeRequest,
  type McpSecretMutation,
  type McpServerWrite,
  type McpSettingsSnapshot,
} from "@fffattiger/pix-runtime-core";
import {
  MCP_PROBE_STATES as WIRE_PROBE_STATES,
  MCP_SERVER_KINDS as WIRE_KINDS,
  McpEnabledMutationSchema,
  McpImportPreviewResponseSchema,
  McpImportRequestSchema,
  McpProbeRequestSchema,
  McpSecretMutationSchema,
  McpServerWriteSchema,
  McpSettingsResponseSchema,
  type McpSettingsResponse,
} from "@fffattiger/pix-protocol";

test("MCP vocabularies are identical in runtime-core and protocol", () => {
  assert.deepEqual([...WIRE_KINDS], [...CANONICAL_KINDS]);
  assert.deepEqual([...WIRE_KINDS], ["stdio", "http"]);
  assert.deepEqual([...WIRE_PROBE_STATES], [...CANONICAL_PROBE_STATES]);
  assert.deepEqual([...WIRE_PROBE_STATES], ["connected", "needs_auth", "failed", "disabled", "unknown"]);
});

const noProbe = { state: "unknown", tools: [], error: null, stderrTail: [], probedAt: null } as const;

function snapshot(): McpSettingsSnapshot {
  return {
    servers: [
      {
        name: "github",
        valid: true,
        invalidReason: null,
        kind: "http",
        enabled: true,
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: "https://example.com/mcp",
        headers: {
          // Whole-value references pass through verbatim…
          Authorization: { redacted: false, value: "${GITHUB_TOKEN}" },
          // …literal values (including embedded references like "Bearer ${T}")
          // are redacted at the source and stay redacted.
          "X-Api-Key": { redacted: true },
        },
        timeout: 60,
        description: "GitHub tools",
        status: { state: "connected", tools: [{ name: "search_issues", description: "Search issues" }], error: null, stderrTail: [], probedAt: 1 },
      },
      {
        name: "broken",
        valid: false,
        invalidReason: "type \"sse\" is not supported",
        kind: null,
        enabled: true,
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: null,
        headers: null,
        timeout: null,
        description: null,
        status: noProbe,
      },
    ],
  };
}

test("MCP snapshot and write envelopes round-trip through the wire schemas", () => {
  const wire: McpSettingsResponse = McpSettingsResponseSchema.parse(snapshot());
  assert.deepEqual(wire, snapshot());

  const write: McpServerWrite = {
    name: "filesystem",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: { TOOLS_KEY: { mode: "preserve" }, OLD: { mode: "remove" }, NEW: { mode: "replace", value: "${NEW_KEY}" } },
    timeout: 30,
  };
  assert.deepEqual(McpServerWriteSchema.parse(write), write);
  assert.deepEqual(McpSecretMutationSchema.parse({ mode: "replace", value: "!echo token" }), { mode: "replace", value: "!echo token" });

  const enabled: McpEnabledMutation = { enabled: false };
  assert.deepEqual(McpEnabledMutationSchema.parse(enabled), enabled);
  const probe: McpProbeRequest = { refresh: true };
  assert.deepEqual(McpProbeRequestSchema.parse(probe), probe);
  const importRequest: McpImportRequest = { json: "{\"mcpServers\":{}}" };
  assert.deepEqual(McpImportRequestSchema.parse(importRequest), importRequest);

  const preview: McpImportPreview = {
    entries: [
      { name: "docs", valid: true, invalidReason: null, overwrite: false, kind: "http" },
      { name: "bad", valid: false, invalidReason: "sse is not supported", overwrite: true, kind: null },
    ],
  };
  assert.deepEqual(McpImportPreviewResponseSchema.parse(preview), preview);
});

test("wire rejects unknown kinds/states, extra fields, and literal secret payloads", () => {
  assert.equal(McpServerWriteSchema.safeParse({ name: "x", kind: "sse" }).success, false);
  assert.equal(McpSettingsResponseSchema.safeParse({ servers: [{ ...snapshot().servers[0]!, status: { ...noProbe, state: "probing" } }] }).success, false);
  assert.equal(McpSettingsResponseSchema.safeParse({ servers: [], extra: 1 }).success, false);
  assert.equal(McpServerWriteSchema.safeParse({ name: "x", kind: "http", url: "https://a", extra: 1 }).success, false);
  assert.equal(McpSecretMutationSchema.safeParse({ mode: "replace", value: "" }).success, false);
  // A literal secret masquerading as a reference-shaped payload is rejected:
  // `redacted:false` values may only be whole-value references (the adapter
  // enforces the same rule before projecting).
  assert.equal(McpSecretMutationSchema.safeParse({ mode: "keep" }).success, false);
  const withLiteral = JSON.parse(JSON.stringify(snapshot())) as ReturnType<typeof snapshot>;
  (withLiteral.servers[0]!.headers!["X-Api-Key"] as { redacted: false; value: string }) = { redacted: false, value: "ghp_literal" };
  assert.equal(McpSettingsResponseSchema.safeParse(withLiteral).success, false);
});
