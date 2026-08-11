import type { RuntimeCommandType } from "./commands.js";
import type { RuntimeInterruptType } from "./interrupt.js";

/**
 * Canonical agent-runtime capabilities.
 *
 * Capability tokens express what the *product* can do, never how a backend
 * provides it. No token encodes a backend identity — there is no `sdk`/`rpc`
 * marker anywhere in the capability vocabulary. Adapters project backend
 * abilities into this canonical set; the rest of the system degrades by
 * capability, not by backend type.
 *
 * Command → capability mapping is defined per adapter; the canonical mapping
 * used by the contract suite is:
 *
 * - prompt        → `runtime.prompt`
 * - steer        → `runtime.steer`
 * - follow_up    → `runtime.follow_up`
 * - clear_queue / set_auto_retry → `runtime.queue`
 * - abort         → `runtime.abort`
 * - set_model     → `runtime.model.set`
 * - set_thinking_level → `runtime.thinking.set`
 * - get_tools     → `runtime.tools.read`
 * - set_tools     → `runtime.tools.write`
 * - compact       → `runtime.compact`
 * - abort_compaction → `runtime.compact.abort`
 * - fork          → `runtime.fork`
 * - navigate_tree → `runtime.navigate`
 * - bash          → `runtime.bash`
 * - abort_bash    → `runtime.bash.abort`
 * - reload        → `runtime.reload`
 * - extension_ui_response / extension_ui_input → `runtime.extension_ui`
 * - generate_session_title → `runtime.auto_name`
 * - set_session_name → `runtime.session.rename`
 * - get_session_stats → `runtime.stats`
 * - get_state / get_commands / get_last_assistant_text are always available.
 */
export const RUNTIME_CAPABILITIES = [
  "runtime.prompt",
  "runtime.steer",
  "runtime.follow_up",
  "runtime.abort",
  "runtime.model.set",
  "runtime.thinking.set",
  "runtime.tools.read",
  "runtime.tools.write",
  "runtime.compact",
  "runtime.compact.abort",
  "runtime.fork",
  "runtime.navigate",
  "runtime.bash",
  "runtime.bash.abort",
  "runtime.reload",
  "runtime.extension_ui",
  "runtime.auto_name",
  "runtime.session.rename",
  "runtime.queue",
  "runtime.stats",
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/**
 * Canonical command → capability mapping used by every adapter and by the
 * shared contract suite. A `null` requirement means the command is a
 * baseline query/configuration operation that is always available.
 */
export const RUNTIME_COMMAND_CAPABILITIES = {
  prompt: "runtime.prompt",
  abort: "runtime.abort",
  get_state: null,
  set_model: "runtime.model.set",
  fork: "runtime.fork",
  navigate_tree: "runtime.navigate",
  set_thinking_level: "runtime.thinking.set",
  compact: "runtime.compact",
  set_session_name: "runtime.session.rename",
  get_session_stats: "runtime.stats",
  get_last_assistant_text: null,
  set_auto_compaction: "runtime.compact",
  clear_queue: "runtime.queue",
  steer: "runtime.steer",
  follow_up: "runtime.follow_up",
  get_tools: "runtime.tools.read",
  get_commands: null,
  set_tools: "runtime.tools.write",
  reload: "runtime.reload",
  abort_compaction: "runtime.compact.abort",
  extension_ui_response: "runtime.extension_ui",
  extension_ui_input: "runtime.extension_ui",
  set_auto_retry: "runtime.queue",
  bash: "runtime.bash",
  abort_bash: "runtime.bash.abort",
  generate_session_title: "runtime.auto_name",
} as const satisfies Readonly<Record<RuntimeCommandType, RuntimeCapability | null>>;

export function requiredCapabilityForCommand(
  type: RuntimeCommandType,
): RuntimeCapability | null {
  return RUNTIME_COMMAND_CAPABILITIES[type];
}

/** Canonical interrupt → capability mapping for the independent control path. */
export const RUNTIME_INTERRUPT_CAPABILITIES = {
  abort: "runtime.abort",
  abort_bash: "runtime.bash.abort",
  abort_compaction: "runtime.compact.abort",
  clear_queue: "runtime.queue",
} as const satisfies Readonly<Record<RuntimeInterruptType, RuntimeCapability>>;

export function requiredCapabilityForInterrupt(
  type: RuntimeInterruptType,
): RuntimeCapability {
  return RUNTIME_INTERRUPT_CAPABILITIES[type];
}

/**
 * The capability snapshot a runtime reports.
 *
 * `version` is bumped whenever the set changes at runtime (for example after
 * a `reload` command) so consumers can tell the set apart from a previous one.
 */
export interface RuntimeCapabilitySet {
  readonly capabilities: readonly RuntimeCapability[];
  readonly version: number;
}

export function createCapabilitySet(
  capabilities: readonly RuntimeCapability[],
  version = 1,
): RuntimeCapabilitySet {
  return { capabilities, version };
}

export function hasRuntimeCapability(
  set: RuntimeCapabilitySet | undefined,
  capability: RuntimeCapability,
): boolean {
  return Boolean(set?.capabilities.includes(capability));
}
