/**
 * Cross-package tool-settings contract — Protocol wire projection vs the
 * runtime-core canonical ToolSettingsSnapshot/ToolSettingsMutation shapes.
 * Protocol cannot import runtime-core; these tests pin the selection modes
 * and the CAS mutation semantics by semantic equality.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ToolSettingsMutation,
  ToolSettingsSnapshot,
} from "@fffattiger/pix-runtime-core";
import {
  ToolSettingsMutationSchema,
  ToolSettingsResponseSchema,
  type ToolSettingsMutation as WireMutation,
  type ToolSettingsResponse as WireResponse,
} from "@fffattiger/pix-protocol";

const revision = "a".repeat(64);

test("protocol tool-settings DTOs accept every canonical selection mode", () => {
  const cases: ToolSettingsSnapshot[] = [
    { revision, selection: { mode: "all" } },
    { revision, selection: { mode: "custom", toolNames: ["read", "codemode"] } },
    { revision, selection: { mode: "custom", toolNames: [] } },
    { revision, selection: { mode: "native", toolNames: ["read", "bash"] } },
  ];
  for (const snapshot of cases) {
    const response: WireResponse = ToolSettingsResponseSchema.parse(snapshot);
    assert.deepEqual(response, snapshot);
  }
});

test("protocol tool-settings mutation mirrors the canonical null/array CAS semantics", () => {
  for (const toolNames of [null, [], ["read"], ["read", "tool_search"]] as const) {
    const mutation: ToolSettingsMutation = { expectedRevision: revision, toolNames };
    const wire: WireMutation = ToolSettingsMutationSchema.parse(mutation);
    assert.deepEqual(wire, { expectedRevision: revision, toolNames });
  }
});

test("protocol tool-settings schemas fail closed on malformed shapes", () => {
  const badResponses = [
    { revision, selection: { mode: "everything" } },
    { revision, selection: { mode: "all", toolNames: [] } },
    { revision, selection: { mode: "custom" } },
    { revision, selection: { mode: "custom", toolNames: "read" } },
    { revision, selection: { mode: "custom", toolNames: [""] } },
    { revision, selection: { mode: "native", toolNames: ["read"], extra: 1 } },
    { revision: "nothex", selection: { mode: "all" } },
  ];
  for (const bad of badResponses) {
    assert.equal(ToolSettingsResponseSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  const badMutations = [
    { expectedRevision: revision },
    { expectedRevision: revision, toolNames: "read" },
    { expectedRevision: revision, toolNames: ["read"], extra: 1 },
    { expectedRevision: "nothex", toolNames: null },
  ];
  for (const bad of badMutations) {
    assert.equal(ToolSettingsMutationSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
