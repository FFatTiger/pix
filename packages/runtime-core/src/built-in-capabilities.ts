/**
 * Canonical Pix built-in capability vocabulary and desired-enablement port.
 *
 * Upper layers speak only these feature IDs. Pi package names stay inside the
 * adapter. Durable desired enablement is a Pix product snapshot, not Pi
 * `settings.json` / Plugins inventory.
 */

export const BUILT_IN_CAPABILITY_IDS = [
  "subagents",
  "todo",
  "ask_user_question",
  "side_chat",
] as const;

export type BuiltInCapabilityId = (typeof BUILT_IN_CAPABILITY_IDS)[number];

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
 * Full-replacement write list: exactly the four canonical IDs, no duplicates,
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
