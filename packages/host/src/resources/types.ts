import type { AllowedRootService } from "./allowed-roots.js";
import type { ProcessRunner } from "./process-runner.js";
import type { ManagedWorktreesService } from "./managed-worktrees.js";

export interface ResourceLimits {
  maxUploadFileBytes?: number;
  maxUploadTotalBytes?: number;
  maxTextPreviewBytes?: number;
  maxBinaryPreviewBytes?: number;
  maxIndexFiles?: number;
  maxIndexDepth?: number;
  maxWatchers?: number;
  processTimeoutMs?: number;
  processOutputBytes?: number;
}

export interface WorktreeBusyPreflight {
  check(path: string): Promise<{ busy: boolean; reason?: string }>;
}

/**
 * Availability guard for sessiond-dependent mutations (worktree create/remove).
 * Worktree writes need the runtime authority up — they track active Agent
 * sessions for safe removal — so the production composition wires a
 * sessiond-backed guard (the SessiondWorktreeSafetyAdapter) and calls
 * {@link assertAvailable} before any worktree write. A thrown error must map to
 * 503 and carry no sessiond endpoint/secret/session identifiers.
 *
 * Pure resource writes (file uploads, git) are Host-mounted and sessiond-
 * independent, so they are NOT guarded — files.write/files.upload/git stay
 * honestly advertised in degraded capabilities. The guard is optional: generic
 * tests omit it; the production composition wires it.
 */
export interface MutationGuard {
  assertAvailable(): Promise<void>;
}

export interface DefaultCwdFactory {
  create(): Promise<{ cwd: string; projectRoot: string }>;
}

export interface ResourceDeps {
  allowedRoots: AllowedRootService;
  processRunner?: ProcessRunner;
  busyPreflight?: WorktreeBusyPreflight;
  /**
   * Optional availability guard for sessiond-dependent mutations (worktree
   * create/remove). When wired, the worktree POST/DELETE routes call
   * {@link MutationGuard.assertAvailable} before any write; GET reads and
   * sessiond-independent resource writes (file uploads, git) stay available
   * regardless. Generic tests omit it; the production composition wires a
   * sessiond-backed guard (the shared SessiondWorktreeSafetyAdapter, which also
   * serves as {@link WorktreeBusyPreflight}).
   */
  mutationGuard?: MutationGuard;
  /**
   * Managed-worktree ownership service (D3A managed-worktree ledger/domain).
   * When wired, worktree POST/DELETE require it and the managed ledger becomes
   * the ONLY delete authority (Git topology membership alone never suffices).
   * When absent, POST/DELETE fail closed BEFORE any Git/filesystem effect (GET
   * stays read-only with `managedByPix: false`). Production composition always
   * wires it over the shared host-state lease.
   */
  managedWorktrees?: ManagedWorktreesService;
  defaultCwdFactory?: DefaultCwdFactory;
  limits?: ResourceLimits;
  /** Optional operator-selected default cwd; must still be in allowed roots. */
  defaultCwd?: string;
}
