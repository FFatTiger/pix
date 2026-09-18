import { z } from "zod";
import { READ_ONLY_RUNTIME_COMMAND_TYPES } from "./commands.js";
import {
  EpochSchema,
  NonEmptyStringSchema,
  ProtocolErrorSchema,
  SlashCommandInfoSchema,
  ToolInfoSchema,
} from "./common.js";
import { SessionStatsSchema } from "./results.js";
import { RuntimeStateSchema } from "./snapshot.js";

/**
 * Protocol v2 additive independent read RPC (Phase 2B).
 *
 * Reads (`get_state` / `get_session_stats` / `get_last_assistant_text` /
 * `get_tools` / `get_commands`) travel on their own bounded lane and are
 * correlated by `(sessionId, epoch, requestId)` instead of the mutation
 * at-most-once `commandId` ledger. Every correlated read result carries the
 * full identity triple plus the typed outcome so a late/wrong-id frame can
 * never settle a different pending read.
 */

export const RuntimeReadTypeSchema = z.enum(READ_ONLY_RUNTIME_COMMAND_TYPES);
export type RuntimeReadType = z.infer<typeof RuntimeReadTypeSchema>;

export const RuntimeReadRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("get_state") }),
  z.strictObject({ type: z.literal("get_session_stats") }),
  z.strictObject({ type: z.literal("get_last_assistant_text") }),
  z.strictObject({ type: z.literal("get_tools") }),
  z.strictObject({ type: z.literal("get_commands") }),
]);
export type RuntimeReadRequest = z.infer<typeof RuntimeReadRequestSchema>;

export const RuntimeReadOkSchema = z.discriminatedUnion("type", [
  z.strictObject({ ok: z.literal(true), type: z.literal("get_state"), state: RuntimeStateSchema }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_session_stats"), stats: SessionStatsSchema }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_last_assistant_text"), text: z.string() }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_tools"), tools: z.array(ToolInfoSchema) }),
  z.strictObject({ ok: z.literal(true), type: z.literal("get_commands"), commands: z.array(SlashCommandInfoSchema) }),
]);
export type RuntimeReadOk = z.infer<typeof RuntimeReadOkSchema>;

export const RuntimeReadFailureSchema = z.strictObject({
  ok: z.literal(false),
  type: RuntimeReadTypeSchema,
  error: ProtocolErrorSchema,
});
export type RuntimeReadFailure = z.infer<typeof RuntimeReadFailureSchema>;

export const RuntimeReadOutcomeSchema = z.union([
  RuntimeReadOkSchema,
  RuntimeReadFailureSchema,
]);
export type RuntimeReadOutcome = z.infer<typeof RuntimeReadOutcomeSchema>;

/**
 * Full correlated read result. `requestId` is the browser-issued read
 * correlation id; the whole identity triple + outcome must match a pending
 * read before it may settle it. Strict schema: any missing/extra/mismatched
 * field rejects the frame.
 */
export const CorrelatedRuntimeReadResultSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  epoch: EpochSchema,
  requestId: NonEmptyStringSchema,
  result: RuntimeReadOutcomeSchema,
});
export type CorrelatedRuntimeReadResult = z.infer<
  typeof CorrelatedRuntimeReadResultSchema
>;

export function parseRuntimeReadRequest(input: unknown): RuntimeReadRequest {
  return RuntimeReadRequestSchema.parse(input);
}

export function safeParseRuntimeReadRequest(input: unknown) {
  return RuntimeReadRequestSchema.safeParse(input);
}
