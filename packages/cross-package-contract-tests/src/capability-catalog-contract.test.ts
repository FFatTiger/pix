/**
 * Cross-package capability catalog contract — the Protocol client projection
 * vs the runtime-core canonical registry. Protocol cannot import
 * runtime-core; these tests pin id order, control kinds, i18n keys, detail
 * pages, tool lists and the derived tool-name union by semantic equality so
 * neither copy can drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_CAPABILITY_IDS as CANONICAL_IDS,
  CAPABILITY_REGISTRY,
  BUILTIN_CAPABILITY_REGISTRY,
  validateCapabilityRegistry,
} from "@fffattiger/pix-runtime-core";
import {
  BUILT_IN_CAPABILITY_IDS as WIRE_IDS,
  CAPABILITY_CATALOG,
  BUILTIN_CAPABILITY_CATALOG,
  CAPABILITY_CATALOG_TOOL_NAMES,
  memoryCapabilityCatalogEntry,
} from "@fffattiger/pix-protocol";

test("the canonical registry itself is structurally valid", () => {
  assert.deepEqual(validateCapabilityRegistry(), []);
});

test("protocol catalog mirrors the runtime-core registry entry by entry", () => {
  assert.equal(CAPABILITY_CATALOG.length, CAPABILITY_REGISTRY.length);
  CAPABILITY_REGISTRY.forEach((entry, index) => {
    const projected = CAPABILITY_CATALOG[index]!;
    assert.equal(projected.id, entry.id, `catalog id at ${index}`);
    assert.equal(projected.control, entry.control, `catalog control for ${entry.id}`);
    assert.equal(projected.labelKey, entry.labelKey, `catalog labelKey for ${entry.id}`);
    assert.equal(projected.descriptionKey, entry.descriptionKey, `catalog descriptionKey for ${entry.id}`);
    assert.equal(projected.detailPage, entry.detailPage, `catalog detailPage for ${entry.id}`);
    assert.deepEqual(projected.tools, entry.tools, `catalog tools for ${entry.id}`);
  });
});

test("builtin catalog ids are exactly the wire built-in vocabulary, in document order", () => {
  assert.deepEqual(
    BUILTIN_CAPABILITY_CATALOG.map((entry) => entry.id),
    [...WIRE_IDS],
  );
  assert.deepEqual([...WIRE_IDS], [...CANONICAL_IDS]);
  assert.deepEqual(
    BUILTIN_CAPABILITY_REGISTRY.map((entry) => entry.id),
    BUILTIN_CAPABILITY_CATALOG.map((entry) => entry.id),
  );
});

test("the catalog tool-name union covers exactly the contributed tools", () => {
  const expected = [...new Set(CAPABILITY_REGISTRY.flatMap((entry) => [...entry.tools]))];
  assert.deepEqual(CAPABILITY_CATALOG_TOOL_NAMES, expected);
  // The capability-owned names the tools page and the palette must agree on.
  for (const name of ["Agent", "SendMessage", "TaskOutput", "TaskStop", "todo", "ask_user_question", "smart_compact", "smart_context", "smart_navigation", "smart_tools"]) {
    assert.ok(CAPABILITY_CATALOG_TOOL_NAMES.includes(name), `missing capability tool ${name}`);
  }
  for (const hidden of ["smart_recall", "smart_save_memory"]) {
    assert.equal(CAPABILITY_CATALOG_TOOL_NAMES.includes(hidden), false, `hidden tool ${hidden} must not be catalog-listed`);
  }
});

test("exactly one memory provider entry exists on both sides", () => {
  const canonical = CAPABILITY_REGISTRY.find((entry) => entry.control === "memory_provider");
  const wire = memoryCapabilityCatalogEntry();
  assert.ok(canonical);
  assert.equal(wire.id, canonical.id);
  assert.equal(wire.id, "memory");
});
