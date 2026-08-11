import { z } from "zod";
import { RUNTIME_COMMAND_TYPES } from "./commands.js";
import {
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  SlashCommandInfoSchema,
  ToolInfoSchema,
} from "./common.js";
import { RuntimeStateSchema } from "./snapshot.js";

export const RuntimeCommandTypeSchema = z.enum(RUNTIME_COMMAND_TYPES);

const ackCommandTypes = RUNTIME_COMMAND_TYPES.filter(
  (type) =>
    ![
      "get_state",
      "get_tools",
      "get_commands",
      "get_session_stats",
      "get_last_assistant_text",
      "fork",
    ].includes(type),
) as [
  Exclude<
    (typeof RUNTIME_COMMAND_TYPES)[number],
    | "get_state"
    | "get_tools"
    | "get_commands"
    | "get_session_stats"
    | "get_last_assistant_text"
    | "fork"
  >,
  ...Exclude<
    (typeof RUNTIME_COMMAND_TYPES)[number],
    | "get_state"
    | "get_tools"
    | "get_commands"
    | "get_session_stats"
    | "get_last_assistant_text"
    | "fork"
  >[],
];

export const SessionStatsSchema = z.strictObject({
  messageCount: z.number().int().nonnegative(),
  pendingMessageCount: z.number().int().nonnegative().optional(),
  tokenCount: z.number().nonnegative().optional(),
  contextUsage: z
    .strictObject({
      percent: z.number(),
      contextWindow: z.number().optional(),
      tokens: z.number().optional(),
    })
    .optional(),
});
export type SessionStats = z.infer<typeof SessionStatsSchema>;

export const RuntimeCommandOkSchema = z.discriminatedUnion("type", [
  z.strictObject({ ok: z.literal(true), type: z.literal("get_state"), state: RuntimeStateSchema }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_tools"), tools: z.array(ToolInfoSchema) }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_commands"), commands: z.array(SlashCommandInfoSchema) }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_session_stats"), stats: SessionStatsSchema }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_last_assistant_text"), text: z.string() }),
  z.strictObject({
    ok: z.literal(true),
    type: z.literal("fork"),
    forkedSessionId: NonEmptyStringSchema,
    forkPointEntryId: NonEmptyStringSchema,
  }),
  z.strictObject({ ok: z.literal(true), type: z.enum(ackCommandTypes) }),
]);

export const RuntimeCommandErrorSchema = z.strictObject({
  ok: z.literal(false),
  type: RuntimeCommandTypeSchema,
  error: ProtocolErrorSchema,
});

export const RuntimeCommandOutcomeSchema = z.union([
  RuntimeCommandOkSchema,
  RuntimeCommandErrorSchema,
]);
export type RuntimeCommandOutcome = z.infer<typeof RuntimeCommandOutcomeSchema>;

/** Transport correlation wraps the canonical command outcome. */
export const CorrelatedRuntimeCommandResultSchema = z.strictObject({
  commandId: NonEmptyStringSchema,
  result: RuntimeCommandOutcomeSchema,
});
export type CorrelatedRuntimeCommandResult = z.infer<
  typeof CorrelatedRuntimeCommandResultSchema
>;

export const RuntimeInterruptTypeSchema = z.enum([
  "abort",
  "abort_compaction",
  "abort_bash",
  "clear_queue",
]);
export type RuntimeInterruptType = z.infer<typeof RuntimeInterruptTypeSchema>;

export const RuntimeInterruptSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("abort") }),
  z.strictObject({ type: z.literal("abort_compaction") }),
  z.strictObject({ type: z.literal("abort_bash") }),
  z.strictObject({ type: z.literal("clear_queue") }),
]);
export type RuntimeInterrupt = z.infer<typeof RuntimeInterruptSchema>;

export const RuntimeInterruptResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), type: RuntimeInterruptTypeSchema }),
  z.strictObject({
    ok: z.literal(false),
    type: RuntimeInterruptTypeSchema,
    error: ProtocolErrorSchema,
  }),
]);
export type RuntimeInterruptResult = z.infer<typeof RuntimeInterruptResultSchema>;
