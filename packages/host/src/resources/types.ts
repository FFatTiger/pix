import type { AllowedRootService } from "./allowed-roots.js";
import type { ProcessRunner } from "./process-runner.js";

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

export interface DefaultCwdFactory {
  create(): Promise<{ cwd: string; projectRoot: string }>;
}

export interface ResourceDeps {
  allowedRoots: AllowedRootService;
  processRunner?: ProcessRunner;
  busyPreflight?: WorktreeBusyPreflight;
  defaultCwdFactory?: DefaultCwdFactory;
  limits?: ResourceLimits;
  /** Optional operator-selected default cwd; must still be in allowed roots. */
  defaultCwd?: string;
}
