import { z } from "zod";
import { HostCapabilitiesSchema } from "./capabilities.js";
import { HostModeSchema } from "./handshake.js";

/**
 * HTTP `/v1/bootstrap` schema version. Independent of Runtime
 * {@link PROTOCOL_VERSION}: bootstrap is a Host boot-surface DTO, not the
 * WS/sessiond/Worker runtime protocol.
 *
 * Bumped to 2 when `pathFlavor` became required. Old v1 bodies fail closed.
 */
export const HOST_BOOTSTRAP_SCHEMA_VERSION = 2 as const;

export const HostBootstrapSchemaVersionSchema = z.literal(HOST_BOOTSTRAP_SCHEMA_VERSION);

export type HostBootstrapSchemaVersion = z.infer<typeof HostBootstrapSchemaVersionSchema>;

/**
 * Host-authoritative path grammar for Client compare / mention / fuzzy.
 * Clients must not guess from "looks like C:/" or unconditional toLowerCase().
 */
export const HostPathFlavorSchema = z.enum(["posix", "windows-drive", "windows-unc"]);
export type HostPathFlavor = z.infer<typeof HostPathFlavorSchema>;

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
  pathFlavor: HostPathFlavorSchema,
});
export type HostBootstrapResponse = z.infer<typeof HostBootstrapResponseSchema>;
