import { z } from "zod";

/**
 * Host capability tokens negotiated at handshake.
 * Clients must degrade by capability, never by "is this an app".
 *
 * Read-only domain catalog foundation (D3B-R1A): the resource/auth/model
 * surface is advertised as read tokens only — `models`, `auth.providers`,
 * `skills`, `plugins`. There are deliberately NO mutation tokens
 * (`models.configure`, `skills.manage`, `plugins.manage`) and NO trust-mutation
 * token (`project.trust`); writes/mutations are deferred to later Host
 * composition milestones. Trust state is an internal gate for resource
 * visibility, not a negotiated capability.
 */
export const HostCapabilitySchema = z.enum([
  "agent",
  "sessions",
  "files",
  "files.write",
  "files.watch",
  "files.upload",
  "git",
  "worktree",
  "session.write",
  "session.delete",
  "models",
  "auth.providers",
  "skills",
  "plugins",
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
