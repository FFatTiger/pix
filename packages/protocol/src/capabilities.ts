import { z } from "zod";

/**
 * Host capability tokens negotiated at handshake.
 * Clients must degrade by capability, never by "is this an app".
 *
 * Read-only domain catalog foundation (D3B-R1A): the resource/auth/model
 * surface is advertised as read tokens only — `models`, `auth.providers`,
 * `skills`, `plugins`. There are deliberately NO mutation tokens
 * (`models.configure`, `skills.manage`, `plugins.manage`); those writes stay
 * deferred to later Host composition milestones. Trust state remains an
 * internal gate for resource visibility.
 *
 * Read-only theme catalog token: `themes` — listed/advertised only while the
 * Host actually mounts the theme catalog seam (theme reads never depend on
 * sessiond, so the token stays advertised in the degraded projection too).
 *
 * Project-trust mutation token (D3B trust-mutation slice): `project.trust` —
 * advertised ONLY while the Host actually mounts the trust-mutation seam
 * (production wires the real Pi-SDK-backed mutation port). It is a catalog
 * capability: the persisted trust decision is written by the Host itself and
 * never depends on the per-session Worker, so the token stays advertised in
 * the degraded (sessiond-down) projection too. The token is discovery, never
 * authorization — the route still fail-closes on gate/auth/root checks.
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
  "worktree.write",
  "session.write",
  "session.delete",
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
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
