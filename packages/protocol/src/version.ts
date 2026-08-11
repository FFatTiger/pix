import { z } from "zod";

/** Frozen Pi Runtime Protocol major version. */
export const PROTOCOL_VERSION = 1 as const;

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
