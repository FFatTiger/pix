import { z } from "zod";
import { HostCapabilitiesSchema } from "./capabilities.js";
import { HostModeSchema } from "./handshake.js";

/**
 * HTTP `/v1/bootstrap` schema version. Independent of Runtime
 * {@link PROTOCOL_VERSION}: bootstrap is a Host boot-surface DTO, not the
 * WS/sessiond/Worker runtime protocol. Frozen at 1 until a breaking bootstrap
 * field change requires a bump.
 */
export const HOST_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export const HostBootstrapSchemaVersionSchema = z.literal(HOST_BOOTSTRAP_SCHEMA_VERSION);

export type HostBootstrapSchemaVersion = z.infer<typeof HostBootstrapSchemaVersionSchema>;

export const HostBootstrapGateStatusSchema = z.strictObject({
  required: z.boolean(),
  status: z.enum(["enabled", "disabled", "unconfigured", "error"]),
});
export type HostBootstrapGateStatus = z.infer<typeof HostBootstrapGateStatusSchema>;

/**
 * Strict GET `/v1/bootstrap` body. The wire field remains `protocolVersion`
 * for the existing HTTP surface; its value is {@link HOST_BOOTSTRAP_SCHEMA_VERSION},
 * never Runtime {@link PROTOCOL_VERSION}.
 */
export const HostBootstrapResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.string(),
  protocolVersion: HostBootstrapSchemaVersionSchema,
  sessiond: z.enum(["up", "down", "unknown"]),
  capabilities: HostCapabilitiesSchema,
  mode: HostModeSchema,
  gate: HostBootstrapGateStatusSchema,
});
export type HostBootstrapResponse = z.infer<typeof HostBootstrapResponseSchema>;
