import { LocalAuthorityError, type SecureStateBackend } from "./contracts.js";
import {
  createPosixSecureStateBackend,
  type PosixSecureStateBackendOptions,
} from "./posix.js";

export interface SecureStateBackendFactoryOptions {
  /** Injectable platform for deterministic selection tests. */
  platform?: NodeJS.Platform;
  /** POSIX-only fault-injection/configuration forwarded to the POSIX backend. */
  posix?: PosixSecureStateBackendOptions;
}

/**
 * Select the native secure-state backend before any caller performs a path walk
 * or filesystem mutation. Windows remains fail-closed until its native
 * SID/DACL/file-id backend is implemented; this factory must never route a
 * Windows path through the POSIX implementation.
 */
export function createSecureStateBackend(
  options: SecureStateBackendFactoryOptions = {},
): SecureStateBackend {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new LocalAuthorityError(
      "UNSUPPORTED_PLATFORM",
      "Native Windows secure state is unavailable",
    );
  }
  return createPosixSecureStateBackend(options.posix);
}
