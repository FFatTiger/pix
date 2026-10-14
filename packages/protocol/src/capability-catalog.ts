/**
 * Client projection of the agent-capability registry.
 *
 * Canonical owner is `packages/runtime-core/src/capability-registry.ts`;
 * Protocol cannot import runtime-core (architecture rule 7), so this module
 * mirrors the client-relevant fields and the cross-package contract tests pin
 * the two copies. The client settings pages (capabilities overview, detail
 * page headers, tools-page capability groups) read from here and never keep
 * their own capability lists.
 */

import type { BuiltInCapabilityId } from "./built-in-capabilities.js";
import type { MemoryProviderWire } from "./memory-settings.js";

/** How a capability's switch is stored and toggled. */
export type CapabilityControlWire = "builtin" | "memory_provider";

/** Client-facing fields of one registered capability. */
export interface CapabilityCatalogEntry {
  readonly id: BuiltInCapabilityId | "memory";
  readonly control: CapabilityControlWire;
  /** i18n key of the capability name. */
  readonly labelKey: string;
  /** i18n key of the short capability description. */
  readonly descriptionKey: string;
  /** Detail settings page id in the client settings nav; null = overview row only. */
  readonly detailPage: string | null;
  /**
   * Tools the capability contributes, shown grouped on the tools page and
   * active iff the capability is on. Empty = no static group (the memory
   * providers' tool sets vary with the chosen provider).
   */
  readonly tools: readonly string[];
}

/**
 * The catalog, in registry order. `memory_provider` entries expose their
 * choices through the memory settings wire (their current value is read
 * from the memory settings query, not from this static list).
 */
export const CAPABILITY_CATALOG = [
  {
    id: "subagents",
    control: "builtin",
    labelKey: "desktop.agentFeature.subagents",
    descriptionKey: "desktop.capability.subagents.description",
    detailPage: "subagents",
    tools: ["Agent", "SendMessage", "TaskOutput", "TaskStop"],
  },
  {
    id: "todo",
    control: "builtin",
    labelKey: "desktop.agentFeature.todo",
    descriptionKey: "desktop.capability.todo.description",
    detailPage: null,
    tools: ["todo"],
  },
  {
    id: "ask_user_question",
    control: "builtin",
    labelKey: "desktop.agentFeature.askUserQuestion",
    descriptionKey: "desktop.capability.askUserQuestion.description",
    detailPage: null,
    tools: ["ask_user_question"],
  },
  {
    id: "side_chat",
    control: "builtin",
    labelKey: "desktop.agentFeature.sideChat",
    descriptionKey: "desktop.capability.sideChat.description",
    detailPage: null,
    tools: [],
  },
  {
    id: "smart_compact",
    control: "builtin",
    labelKey: "desktop.agentFeature.smartCompact",
    descriptionKey: "desktop.capability.smartCompact.description",
    detailPage: "compaction",
    tools: ["smart_compact", "smart_context", "smart_navigation", "smart_tools"],
  },
  {
    id: "memory",
    control: "memory_provider",
    labelKey: "desktop.agentFeature.memory",
    descriptionKey: "desktop.capability.memory.description",
    detailPage: "memory",
    tools: [],
  },
] as const satisfies readonly CapabilityCatalogEntry[];

export type CapabilityCatalogEntryLiteral = (typeof CAPABILITY_CATALOG)[number];
export type CapabilityCatalogId = CapabilityCatalogEntryLiteral["id"];

/** Catalog entries for builtin toggles, in persisted document order. */
export const BUILTIN_CAPABILITY_CATALOG: readonly Extract<CapabilityCatalogEntryLiteral, { control: "builtin" }>[] =
  CAPABILITY_CATALOG.filter((entry): entry is Extract<CapabilityCatalogEntryLiteral, { control: "builtin" }> =>
    entry.control === "builtin"
  );

/** The single memory-provider entry; throws if the catalog is malformed. */
export function memoryCapabilityCatalogEntry(): Extract<CapabilityCatalogEntryLiteral, { control: "memory_provider" }> {
  const entry = CAPABILITY_CATALOG.find(
    (candidate): candidate is Extract<CapabilityCatalogEntryLiteral, { control: "memory_provider" }> =>
      candidate.control === "memory_provider",
  );
  if (entry === undefined) throw new Error("capability catalog is missing the memory provider entry");
  return entry;
}

/** Every tool name contributed by a capability (unique, registry order). */
export const CAPABILITY_CATALOG_TOOL_NAMES: readonly string[] = [
  ...new Set(CAPABILITY_CATALOG.flatMap((entry) => [...entry.tools])),
];

/** Catalog entry by id, or undefined. */
export function findCapabilityCatalogEntry(id: string): CapabilityCatalogEntry | undefined {
  return CAPABILITY_CATALOG.find((entry) => entry.id === id);
}

/** i18n key of a memory provider choice label (shared with the memory settings page). */
export function memoryProviderLabelKey(provider: MemoryProviderWire): string {
  return `desktop.memoryProvider_${provider}`;
}
