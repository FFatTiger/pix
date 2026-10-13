/**
 * Assistant workspace resource (Host composition).
 *
 * The Assistant's identity is ONE fixed working directory derived from the
 * user's home: `<home>/.pi/pix/assistant` (runtime-core single derivation).
 * This resource materializes it at Host boot:
 *
 *  1. resolve the directory from `home` (no hardcoded usernames, no env
 *     override — the derivation is shared with the sessiond catalog hide
 *     filter and the Worker tool registration, so it must never fork);
 *  2. create it 0700 if missing (same privacy posture as the pix state dirs);
 *  3. authorize it against AllowedRoots — `authorizeExisting` canonicalizes
 *     and pins root identity exactly like any live workspace. A deployment
 *     whose roots do not contain the directory gets NO assistant (the seam
 *     stays unmounted, the capability is never advertised, the route is not
 *     mounted) — fail-closed degradation, never a guessed authorization;
 *  4. ensure the project-trust decision is `trusted`, written ONCE through
 *     the same narrow trust-mutation seam POST /v1/trust uses. Rationale: the
 *     assistant must never surface a "trust this project?" interruption, and
 *     the directory is Host-managed (created here, 0700, never user-authored)
 *     so trusting it is explicit and restricted to exactly this path. A write
 *     failure is logged and non-fatal: an empty directory has no
 *     trust-requiring project resources, and the SDK keeps withholding
 *     project-local resources for untrusted directories (safe default).
 */
import { mkdir } from "node:fs/promises";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";
import type { AllowedRootService } from "./allowed-roots.js";
import type { CatalogTrustMutationSeam, CatalogTrustSeam, HostLogger } from "../types.js";

export interface AssistantWorkspaceResource {
  /** Canonical (realpath'd) assistant working directory. */
  readonly cwd: string;
}

export interface CreateAssistantWorkspaceOptions {
  /** User home directory (the derivation base). */
  home: string;
  /** The SAME AllowedRoots service the resource routes use. */
  roots: AllowedRootService;
  /** Trust read seam (same seam GET /v1/trust uses). */
  trust?: CatalogTrustSeam;
  /** Trust mutation seam (same seam POST /v1/trust uses). */
  trustMutation?: CatalogTrustMutationSeam;
  logger?: HostLogger;
}

/**
 * Materialize the assistant workspace. Returns null (assistant disabled)
 * when the directory cannot be authorized within AllowedRoots.
 */
export async function createAssistantWorkspaceResource(
  options: CreateAssistantWorkspaceOptions,
): Promise<AssistantWorkspaceResource | null> {
  const dir = resolveAssistantWorkspaceDir(options.home);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    options.logger?.warn?.(`assistant workspace unavailable (cannot create directory): ${(error as Error).message}`);
    return null;
  }
  let canonical: string;
  try {
    canonical = (await options.roots.authorizeExisting(dir, "directory")).canonicalPath;
  } catch {
    // Sanitized: the path itself is derived, never caller-supplied, but the
    // operator-facing reason stays fixed (no root list echo).
    options.logger?.warn?.("assistant workspace is outside PIX_ALLOWED_ROOTS; the assistant entry stays hidden");
    return null;
  }
  // One-time explicit trust of the Host-managed assistant directory (never a
  // user prompt). Read-first so a healthy deployment writes nothing at boot.
  if (options.trust && options.trustMutation) {
    try {
      if (!(await options.trust.isTrusted(canonical))) {
        await options.trustMutation.setTrusted(canonical);
      }
    } catch (error) {
      options.logger?.warn?.(`assistant workspace trust ensure failed (non-fatal): ${(error as Error).message}`);
    }
  }
  return { cwd: canonical };
}
