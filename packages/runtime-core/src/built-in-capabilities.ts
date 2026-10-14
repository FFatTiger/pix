/**
 * Canonical Pix built-in capability vocabulary and desired-enablement port.
 *
 * Upper layers speak only these feature IDs. Pi package names stay inside the
 * adapter. Durable desired enablement is a Pix product snapshot, not Pi
 * `settings.json` / Plugins inventory.
 *
 * The id vocabulary and its order derive from the capability registry
 * (`capability-registry.ts`) — register a capability there, not here. A new
 * builtin toggle changes the `pix-builtins.json` document vocabulary and
 * needs the store schema migration in this module and the adapter document
 * parser.
 */

import { BUILTIN_CAPABILITY_REGISTRY } from "./capability-registry.js";

const REGISTRY_BUILT_IN_IDS = BUILTIN_CAPABILITY_REGISTRY.map((entry) => entry.id);

export const BUILT_IN_CAPABILITY_IDS: readonly (typeof REGISTRY_BUILT_IN_IDS)[number][] = REGISTRY_BUILT_IN_IDS;

export type BuiltInCapabilityId = (typeof REGISTRY_BUILT_IN_IDS)[number];

export interface BuiltInCapabilityState {
  id: BuiltInCapabilityId;
  enabled: boolean;
}

export interface BuiltInCapabilityConfigSnapshot {
  /** SHA-256 of the exact persisted bytes; empty-file digest when absent. */
  revision: string;
  capabilities: readonly BuiltInCapabilityState[];
}

export interface BuiltInCapabilityConfigWrite {
  expectedRevision: string;
  capabilities: readonly BuiltInCapabilityState[];
}

/** Writable Pix built-in desired-enablement authority. */
export interface BuiltInCapabilityConfigStorePort {
  readConfig(): Promise<BuiltInCapabilityConfigSnapshot>;
  writeConfig(input: BuiltInCapabilityConfigWrite): Promise<BuiltInCapabilityConfigSnapshot>;
}

const ID_SET: ReadonlySet<string> = new Set(BUILT_IN_CAPABILITY_IDS);

export function isBuiltInCapabilityId(value: string): value is BuiltInCapabilityId {
  return ID_SET.has(value);
}

/** Missing durable file means every built-in is enabled. */
export function defaultBuiltInCapabilities(): BuiltInCapabilityState[] {
  return BUILT_IN_CAPABILITY_IDS.map((id) => ({ id, enabled: true }));
}

/**
 * Full-replacement write list: exactly the canonical IDs, no duplicates,
 * no extras, each with a boolean. Returns canonical ID order, or null.
 */
export function normalizeBuiltInCapabilityList(value: unknown): BuiltInCapabilityState[] | null {
  if (!Array.isArray(value) || value.length !== BUILT_IN_CAPABILITY_IDS.length) return null;
  const enabledById = new Map<BuiltInCapabilityId, boolean>();
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("id") || !keys.includes("enabled")) return null;
    const id = (item as { id: unknown }).id;
    const enabled = (item as { enabled: unknown }).enabled;
    if (typeof id !== "string" || typeof enabled !== "boolean") return null;
    if (!isBuiltInCapabilityId(id) || enabledById.has(id)) return null;
    enabledById.set(id, enabled);
  }
  if (enabledById.size !== BUILT_IN_CAPABILITY_IDS.length) return null;
  return BUILT_IN_CAPABILITY_IDS.map((id) => ({ id, enabled: enabledById.get(id)! }));
}
