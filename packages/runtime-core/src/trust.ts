/**
 * Canonical project-trust DTOs.
 *
 * Trust is an exact tri-state: `unknown` (no decision recorded), `trusted`,
 * or `denied`. The read-only query port
 * ({@link ProjectTrustQueryPort} in `./ports.js`) surfaces this exact state;
 * the independent narrow mutation port ({@link ProjectTrustMutationPort})
 * records an explicit decision (this slice: set trusted only).
 *
 * Project-scoped trust reads always take an explicit `cwd` (see
 * {@link ProjectCatalogContext}) and never rely on implicit process.cwd. The
 * tri-state mirrors the Protocol trust vocabulary so backends (Pi SDK trust
 * store: null→unknown, true→trusted, false→denied) project directly onto it.
 */

/** Canonical project-trust state (exact tri-state). */
export type ProjectTrustState = "unknown" | "trusted" | "denied";

export interface ProjectTrustStatus {
  cwd: string;
  level: ProjectTrustState;
  reason?: string;
  /** Provenance of the decision (e.g. "saved", "default", "denied"). */
  source?: string;
}

export interface TrustGateResult {
  allowed: boolean;
  level: ProjectTrustState;
  reason?: string;
}
