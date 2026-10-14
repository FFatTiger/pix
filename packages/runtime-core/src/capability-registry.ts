/**
 * Canonical Pix agent-capability registry.
 *
 * ONE place registers every built-in agent capability Pix ships: its id, the
 * i18n keys for its name/description, where its switch lives (`pix-builtins.json`
 * toggle vs the settings.json memory-provider choice), its detail settings
 * page, the tools/commands it contributes, the tools it contributes but keeps
 * invisible, its dynamic runtime token, and the assistant prompt sections it
 * contributes. The loading layer (`pi-sdk-adapter` curated plugins + tool
 * selection), the settings pages and the tools-page groups (`client`, through
 * the Protocol `capability-catalog` projection, which contract tests pin to
 * this registry), and the assistant prompt section selection all read from
 * here — none of them keeps its own capability list.
 *
 * Ownership split (architecture rule 1): runtime-core owns the product
 * semantics above; the npm package names of the bundled plugins stay inside
 * `pi-sdk-adapter` (`curated-plugins.ts` binds registry capability ids to
 * vendored packages). Adding a built-in capability = one registry entry here
 * + the Protocol catalog projection (enforced by cross-package contract
 * tests) + the adapter package binding; a new `pix-builtins.json` toggle
 * additionally needs the store schema migration in
 * `built-in-capabilities.ts` / the adapter document parser.
 */

import type { RuntimeCapability } from "./capabilities.js";
import type { MemoryProvider } from "./settings-config.js";

/** How a capability's switch is stored and toggled. */
export type CapabilityControlKind = "builtin" | "memory_provider";

/** One registered capability. Fields are product semantics only — no npm package names. */
export interface CapabilityRegistryEntry {
  /** Stable capability id (`BuiltInCapabilityId` for builtin toggles, `memory` for the provider choice). */
  readonly id: string;
  /** `builtin`: on/off boolean in `pix-builtins.json`. `memory_provider`: the settings.json `pixMemoryProvider` choice. */
  readonly control: CapabilityControlKind;
  /** i18n key of the capability name. */
  readonly labelKey: string;
  /** i18n key of the short capability description. */
  readonly descriptionKey: string;
  /** Detail settings page id in the client settings nav; null = overview row only. */
  readonly detailPage: string | null;
  /** Tools the capability contributes. They appear grouped on the tools page and are active iff the capability is on. */
  readonly tools: readonly string[];
  /** Tools the capability contributes but never exposes (not user-visible, never active). */
  readonly hiddenTools: readonly string[];
  /** Slash commands the capability contributes (also its load-detection surface, with `tools`). */
  readonly commands: readonly string[];
  /** Dynamic runtime capability token advertised while loaded; null = none. */
  readonly runtimeToken: RuntimeCapability | null;
  /** Assistant prompt section id per memory-provider choice; absent choice (e.g. off) = no section. */
  readonly assistantPromptSections: Readonly<Partial<Record<MemoryProvider, string>>>;
}

/**
 * The registry. Builtin-toggle entry order fixes the `pix-builtins.json`
 * canonical id order — inserting or reordering a builtin entry changes the
 * persisted document vocabulary and needs a store schema migration.
 */
export const CAPABILITY_REGISTRY = [
  {
    id: "subagents",
    control: "builtin",
    labelKey: "desktop.agentFeature.subagents",
    descriptionKey: "desktop.capability.subagents.description",
    detailPage: "subagents",
    tools: ["Agent", "SendMessage", "TaskOutput", "TaskStop"],
    hiddenTools: [],
    commands: ["agents", "pi-subagents-doctor"],
    runtimeToken: "runtime.subagents",
    assistantPromptSections: {},
  },
  {
    id: "todo",
    control: "builtin",
    labelKey: "desktop.agentFeature.todo",
    descriptionKey: "desktop.capability.todo.description",
    detailPage: null,
    tools: ["todo"],
    hiddenTools: [],
    commands: ["todos"],
    runtimeToken: "runtime.todo",
    assistantPromptSections: {},
  },
  {
    id: "ask_user_question",
    control: "builtin",
    labelKey: "desktop.agentFeature.askUserQuestion",
    descriptionKey: "desktop.capability.askUserQuestion.description",
    detailPage: null,
    tools: ["ask_user_question"],
    hiddenTools: [],
    commands: [],
    runtimeToken: "runtime.user_question",
    assistantPromptSections: {},
  },
  {
    id: "side_chat",
    control: "builtin",
    labelKey: "desktop.agentFeature.sideChat",
    descriptionKey: "desktop.capability.sideChat.description",
    detailPage: null,
    tools: [],
    hiddenTools: [],
    commands: [],
    runtimeToken: "runtime.side_chat",
    assistantPromptSections: {},
  },
  {
    id: "smart_compact",
    control: "builtin",
    labelKey: "desktop.agentFeature.smartCompact",
    descriptionKey: "desktop.capability.smartCompact.description",
    detailPage: "compaction",
    tools: ["smart_compact", "smart_context", "smart_navigation", "smart_tools"],
    // The plugin's own memory tools are always hidden: memory has one owner.
    hiddenTools: ["smart_recall", "smart_save_memory"],
    commands: ["smart-compact"],
    runtimeToken: null,
    assistantPromptSections: {},
  },
  {
    id: "memory",
    control: "memory_provider",
    labelKey: "desktop.agentFeature.memory",
    descriptionKey: "desktop.capability.memory.description",
    detailPage: "memory",
    // Tool set varies with the chosen provider (pi-memory vs the Lore
    // extension family), so no static tools-page group is registered.
    tools: [],
    hiddenTools: [],
    commands: [],
    runtimeToken: null,
    assistantPromptSections: {
      local: "assistant.memory.local",
      lore: "assistant.memory.lore",
    },
  },
] as const satisfies readonly CapabilityRegistryEntry[];

export type CapabilityRegistryEntryLiteral = (typeof CAPABILITY_REGISTRY)[number];
export type CapabilityRegistryId = CapabilityRegistryEntryLiteral["id"];

/** Registry entries whose switch is a `pix-builtins.json` toggle. */
export type BuiltinCapabilityRegistryEntry = Extract<CapabilityRegistryEntryLiteral, { control: "builtin" }>;
/** The memory-provider choice entry. */
export type MemoryCapabilityRegistryEntry = Extract<CapabilityRegistryEntryLiteral, { control: "memory_provider" }>;

/** Builtin-toggle entries in registry (= persisted document) order. */
export const BUILTIN_CAPABILITY_REGISTRY: readonly BuiltinCapabilityRegistryEntry[] = CAPABILITY_REGISTRY.filter(
  (entry): entry is BuiltinCapabilityRegistryEntry => entry.control === "builtin",
);

/** The single memory-provider entry; throws if the registry is malformed. */
export function memoryCapabilityRegistryEntry(): MemoryCapabilityRegistryEntry {
  const entry = CAPABILITY_REGISTRY.find(
    (candidate): candidate is MemoryCapabilityRegistryEntry => candidate.control === "memory_provider",
  );
  if (entry === undefined) throw new Error("capability registry is missing the memory provider entry");
  return entry;
}

/** Registry entry by id, or undefined. */
export function findCapabilityRegistryEntry(id: string): CapabilityRegistryEntry | undefined {
  return CAPABILITY_REGISTRY.find((entry) => entry.id === id);
}

/**
 * Structural invariants of the registry. Pure (no I/O) so tests can pin it;
 * returns an empty list when the registry is well-formed.
 */
export function validateCapabilityRegistry(): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const toolOwner = new Map<string, string>();
  for (const entry of CAPABILITY_REGISTRY) {
    if (ids.has(entry.id)) errors.push(`duplicate capability id: ${entry.id}`);
    ids.add(entry.id);
    if (!/^[a-z][a-z0-9_]*$/.test(entry.id)) errors.push(`capability id is not snake_case: ${entry.id}`);
    if (typeof entry.labelKey !== "string" || entry.labelKey.length === 0) errors.push(`missing labelKey: ${entry.id}`);
    if (typeof entry.descriptionKey !== "string" || entry.descriptionKey.length === 0) {
      errors.push(`missing descriptionKey: ${entry.id}`);
    }
    for (const list of [entry.tools, entry.hiddenTools, entry.commands] as const) {
      if (new Set(list).size !== list.length) errors.push(`duplicate names in ${entry.id}`);
    }
    for (const name of [...entry.tools, ...entry.hiddenTools]) {
      const owner = toolOwner.get(name);
      if (owner !== undefined) errors.push(`tool ${name} is contributed by both ${owner} and ${entry.id}`);
      toolOwner.set(name, entry.id);
    }
    const sectionChoices = Object.keys(entry.assistantPromptSections) as MemoryProvider[];
    for (const choice of sectionChoices) {
      if (choice !== "local" && choice !== "lore" && choice !== "off") {
        errors.push(`unknown prompt-section choice ${choice} on ${entry.id}`);
      }
    }
  }
  const memoryEntries = CAPABILITY_REGISTRY.filter((entry) => entry.control === "memory_provider");
  if (memoryEntries.length !== 1) errors.push(`expected exactly one memory_provider entry, found ${memoryEntries.length}`);
  if (!ids.has("memory")) errors.push("registry is missing the memory capability");
  return errors;
}
