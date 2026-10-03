import type {
  BuiltInCapabilityId,
  BuiltInLoadFailure,
  BuiltInRuntimeState,
  RuntimeCapability,
} from "@fffattiger/pix-runtime-core";
import {
  BUILT_IN_CAPABILITY_IDS,
  normalizeBuiltInRuntimeState,
} from "@fffattiger/pix-runtime-core";
import type { BuiltInCapabilityConfigRead } from "./built-in-capability-store.js";

export const SUBAGENT_TOOL_NAMES = ["Agent", "SendMessage", "TaskOutput", "TaskStop"] as const;
export const SUBAGENT_COMMAND_NAMES = ["agents", "pi-subagents-doctor"] as const;
export const TODO_TOOL_NAME = "todo";
export const TODO_COMMAND_NAME = "todos";
export const ASK_TOOL_NAME = "ask_user_question";

const DYNAMIC_TOKENS = {
  subagents: "runtime.subagents",
  todo: "runtime.todo",
  ask_user_question: "runtime.user_question",
  side_chat: "runtime.side_chat",
} as const satisfies Record<BuiltInCapabilityId, RuntimeCapability>;

export interface NamedSurface {
  name: string;
}

function hasAll(names: ReadonlySet<string>, expected: readonly string[]): boolean {
  return expected.every((name) => names.has(name));
}

export function detectLoadedBuiltIns(input: {
  tools: readonly NamedSurface[];
  commands: readonly NamedSurface[];
}): ReadonlySet<BuiltInCapabilityId> {
  const tools = new Set(input.tools.map((item) => item.name));
  const commands = new Set(input.commands.map((item) => item.name));
  const loaded = new Set<BuiltInCapabilityId>();
  if (hasAll(tools, SUBAGENT_TOOL_NAMES) && hasAll(commands, SUBAGENT_COMMAND_NAMES)) loaded.add("subagents");
  if (tools.has(TODO_TOOL_NAME) && commands.has(TODO_COMMAND_NAME)) loaded.add("todo");
  if (tools.has(ASK_TOOL_NAME)) loaded.add("ask_user_question");
  return loaded;
}

export function buildBuiltInRuntimeState(input: {
  config: BuiltInCapabilityConfigRead;
  loaded: ReadonlySet<BuiltInCapabilityId>;
}): BuiltInRuntimeState {
  const desired = new Map(input.config.capabilities.map((row) => [row.id, row.enabled]));
  const loaded: BuiltInCapabilityId[] = [];
  const failures: BuiltInLoadFailure[] = [];
  for (const id of BUILT_IN_CAPABILITY_IDS) {
    if (desired.get(id) !== true) continue;
    if (input.loaded.has(id)) loaded.push(id);
    else failures.push({ id, code: "load_failed" });
  }
  const normalized = normalizeBuiltInRuntimeState({
    configRevision: input.config.revision,
    loaded,
    failures,
  });
  if (normalized === null) throw new Error("invalid built-in runtime projection");
  return normalized;
}

export function capabilitiesWithLoadedTokens(
  base: readonly RuntimeCapability[],
  loaded: ReadonlySet<BuiltInCapabilityId>,
): RuntimeCapability[] {
  const next = new Set(base);
  for (const id of BUILT_IN_CAPABILITY_IDS) {
    const token = DYNAMIC_TOKENS[id];
    if (loaded.has(id)) next.add(token);
    else next.delete(token);
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
