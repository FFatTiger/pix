/**
 * Canonical project-trust DTOs for {@link ProjectTrustPort}.
 */

export type TrustLevel = "trusted" | "untrusted";

export interface ProjectTrustStatus {
  cwd: string;
  level: TrustLevel;
  reason?: string;
}

export interface TrustGateResult {
  allowed: boolean;
  level: TrustLevel;
  reason?: string;
}
