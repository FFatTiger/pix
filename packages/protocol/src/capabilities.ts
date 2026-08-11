import { z } from "zod";

/**
 * Host capability tokens negotiated at handshake.
 * Clients must degrade by capability, never by "is this an app".
 */
export const HostCapabilitySchema = z.enum([
  "agent",
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "session.write",
  "session.delete",
  "models",
  "models.configure",
  "auth.providers",
  "skills",
  "skills.manage",
  "plugins",
  "plugins.manage",
  "project.trust",
  "export",
]);

export type HostCapability = z.infer<typeof HostCapabilitySchema>;

export const ALL_HOST_CAPABILITIES: readonly HostCapability[] =
  HostCapabilitySchema.options;

export const HostCapabilitiesSchema = z.array(HostCapabilitySchema);

export function hasCapability(
  capabilities: readonly HostCapability[] | undefined,
  capability: HostCapability,
): boolean {
  return Boolean(capabilities?.includes(capability));
}

export function isAgentEnabled(
  capabilities: readonly HostCapability[] | undefined,
): boolean {
  return hasCapability(capabilities, "agent");
}
