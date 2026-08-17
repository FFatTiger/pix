import { LocalAuthorityError, type SecureStateBackend } from "./contracts.js";
import { loadNativeWindowsBinding } from "./native-windows.js";
import {
  createPosixSecureStateBackend,
  type PosixSecureStateBackendOptions,
} from "./posix.js";
import { createWindowsSecureStateBackend } from "./windows.js";

export interface SecureStateBackendFactoryOptions {
  /** Injectable platform for deterministic selection tests. */
  platform?: NodeJS.Platform;
  /** POSIX-only fault-injection/configuration forwarded to the POSIX backend. */
  posix?: PosixSecureStateBackendOptions;
}

/**
 * Select the native secure-state backend before any caller performs a path walk
 * or filesystem mutation. Windows never routes through the POSIX implementation.
 */
export function createSecureStateBackend(
  options: SecureStateBackendFactoryOptions = {},
): SecureStateBackend {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      loadNativeWindowsBinding();
    } catch {
      throw new LocalAuthorityError(
        "UNSUPPORTED_PLATFORM",
        "Native Windows secure state is unavailable",
      );
    }
    return createWindowsSecureStateBackend();
  }
  return createPosixSecureStateBackend(options.posix);
}
