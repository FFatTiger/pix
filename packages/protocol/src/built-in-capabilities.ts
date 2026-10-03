import { z } from "zod";

/**
 * Wire projection of Pix built-in desired enablement.
 *
 * Canonical owner is `packages/runtime-core/src/built-in-capabilities.ts`.
 * Protocol cannot import runtime-core (architecture rule 7); this module
 * mirrors the vocabulary and snapshot/write shapes. Cross-package parity
 * tests pin the two copies.
 */

export const BUILT_IN_CAPABILITY_IDS = [
  "subagents",
  "todo",
  "ask_user_question",
  "side_chat",
] as const;

export const BuiltInCapabilityIdSchema = z.enum(BUILT_IN_CAPABILITY_IDS);
export type BuiltInCapabilityId = z.infer<typeof BuiltInCapabilityIdSchema>;

export const BuiltInCapabilityStateSchema = z.strictObject({
  id: BuiltInCapabilityIdSchema,
  enabled: z.boolean(),
});
export type BuiltInCapabilityState = z.infer<typeof BuiltInCapabilityStateSchema>;

const RevisionSchema = z.string().regex(/^[0-9a-f]{64}$/);

function exactCanonicalCapabilityList(
  capabilities: readonly BuiltInCapabilityState[],
): boolean {
  if (capabilities.length !== BUILT_IN_CAPABILITY_IDS.length) return false;
  const seen = new Set<string>();
  for (const row of capabilities) {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
  }
  return BUILT_IN_CAPABILITY_IDS.every((id) => seen.has(id));
}

const BuiltInCapabilityListSchema = z
  .array(BuiltInCapabilityStateSchema)
  .superRefine((capabilities, ctx) => {
    if (exactCanonicalCapabilityList(capabilities)) return;
    ctx.addIssue({ code: "custom", message: "built-in capabilities must be the four canonical ids exactly once" });
  });

export const BuiltInCapabilityConfigResponseSchema = z.strictObject({
  revision: RevisionSchema,
  capabilities: BuiltInCapabilityListSchema,
});
export type BuiltInCapabilityConfigResponse = z.infer<typeof BuiltInCapabilityConfigResponseSchema>;

export const BuiltInCapabilityConfigMutationSchema = z.strictObject({
  expectedRevision: RevisionSchema,
  capabilities: BuiltInCapabilityListSchema,
});
export type BuiltInCapabilityConfigMutation = z.infer<typeof BuiltInCapabilityConfigMutationSchema>;
