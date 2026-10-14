import type {
  BuiltInCapabilityId,
  BuiltInLoadFailure,
  BuiltInRuntimeState,
  RuntimeCapability,
} from "@fffattiger/pix-runtime-core";
import {
  BUILTIN_CAPABILITY_REGISTRY,
  findCapabilityRegistryEntry,
  normalizeBuiltInRuntimeState,
} from "@fffattiger/pix-runtime-core";
import type { BuiltInCapabilityConfigRead } from "./built-in-capability-store.js";

/**
 * Load detection + runtime projection for built-in capabilities.
 *
 * Every surface (contributed tools, commands, dynamic runtime tokens, the
 * smart-compact hidden tools) is read from the canonical capability registry
 * (`@fffattiger/pix-runtime-core` `capability-registry.ts`); this module adds
 * no capability lists of its own.
 */

function registryTools(id: string): readonly string[] {
  const entry = findCapabilityRegistryEntry(id);
  if (entry === undefined) throw new Error(`capability registry is missing ${id}`);
  return entry.tools;
}

function registryCommands(id: string): readonly string[] {
  const entry = findCapabilityRegistryEntry(id);
  if (entry === undefined) throw new Error(`capability registry is missing ${id}`);
  return entry.commands;
}

function registryHiddenTools(id: string): readonly string[] {
  const entry = findCapabilityRegistryEntry(id);
  if (entry === undefined) throw new Error(`capability registry is missing ${id}`);
  return entry.hiddenTools;
}

/** Contributed surfaces per capability, straight from the registry. */
export const SUBAGENT_TOOL_NAMES: readonly string[] = registryTools("subagents");
export const SUBAGENT_COMMAND_NAMES: readonly string[] = registryCommands("subagents");
export const TODO_TOOL_NAME: string = registryTools("todo")[0]!;
export const TODO_COMMAND_NAME: string = registryCommands("todo")[0]!;
export const ASK_TOOL_NAME: string = registryTools("ask_user_question")[0]!;
export const SMART_COMPACT_TOOL_NAME: string = registryTools("smart_compact")[0]!;
export const SMART_COMPACT_COMMAND_NAME: string = registryCommands("smart_compact")[0]!;

/** The smart-compact plugin's own memory tools — always hidden, never active. */
export const SMART_COMPACT_MEMORY_TOOL_NAMES: readonly string[] = registryHiddenTools("smart_compact");

export interface NamedSurface {
  name: string;
}

function hasAll(names: ReadonlySet<string>, expected: readonly string[]): boolean {
  return expected.every((name) => names.has(name));
}

/**
 * Detect which builtin capabilities actually loaded, by their registered
 * tool/command surface. `side_chat` registers no tools (it is not a package):
 * the caller adds it from model presence.
 */
export function detectLoadedBuiltIns(input: {
  tools: readonly NamedSurface[];
  commands: readonly NamedSurface[];
}): ReadonlySet<BuiltInCapabilityId> {
  const tools = new Set(input.tools.map((item) => item.name));
  const commands = new Set(input.commands.map((item) => item.name));
  const loaded = new Set<BuiltInCapabilityId>();
  for (const entry of BUILTIN_CAPABILITY_REGISTRY) {
    if (entry.tools.length === 0 && entry.commands.length === 0) continue;
    if (hasAll(tools, entry.tools) && hasAll(commands, entry.commands)) {
      loaded.add(entry.id);
    }
  }
  return loaded;
}

export function buildBuiltInRuntimeState(input: {
  config: BuiltInCapabilityConfigRead;
  loaded: ReadonlySet<BuiltInCapabilityId>;
}): BuiltInRuntimeState {
  const desired = new Map(input.config.capabilities.map((row) => [row.id, row.enabled]));
  const loaded: BuiltInCapabilityId[] = [];
  const failures: BuiltInLoadFailure[] = [];
  for (const entry of BUILTIN_CAPABILITY_REGISTRY) {
    if (desired.get(entry.id) !== true) continue;
    if (input.loaded.has(entry.id)) loaded.push(entry.id);
    else failures.push({ id: entry.id, code: "load_failed" });
  }
  const normalized = normalizeBuiltInRuntimeState({
    configRevision: input.config.revision,
    loaded,
    failures,
  });
  if (normalized === null) throw new Error("invalid built-in runtime projection");
  return normalized;
}

/**
 * Dynamically advertised runtime tokens per loaded built-in, from the
 * registry. `smart_compact` deliberately has NO token: the plugin contributes
 * no runtime command or UI surface (its availability is projected through
 * snapshot `builtIns` exactly like every other built-in), so inventing a token
 * with no consumer would violate the "advertise only what is wired" rule.
 */
export function capabilitiesWithLoadedTokens(
  base: readonly RuntimeCapability[],
  loaded: ReadonlySet<BuiltInCapabilityId>,
): RuntimeCapability[] {
  const next = new Set(base);
  for (const entry of BUILTIN_CAPABILITY_REGISTRY) {
    if (entry.runtimeToken === null) continue;
    if (loaded.has(entry.id)) next.add(entry.runtimeToken);
    else next.delete(entry.runtimeToken);
  }
  return [...next];
}

export function cloneBuiltIns(value: BuiltInRuntimeState): BuiltInRuntimeState {
  return {
    configRevision: value.configRevision,
    loaded: [...value.loaded],
    failures: value.failures.map((row) => ({ id: row.id, code: row.code })),
  };
}
