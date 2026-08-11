import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Environment variable overriding the daemon runtime directory. When unset the
 * daemon uses {@link DEFAULT_SESSIOND_DIRECTORY}. B4 supervision reads the same
 * variable so ensure/reuse/down-all agree with a running daemon.
 */
export const SESSIOND_DIR_ENV = "PI_WEB_SESSIOND_DIR";

/** Default runtime directory: `~/.pi/agent/sessiond`. */
export const DEFAULT_SESSIOND_DIRECTORY = join(homedir(), ".pi", "agent", "sessiond");

/**
 * Resolve the daemon runtime directory. Precedence:
 *   1. explicit `override` (tests / programmatic callers)
 *   2. `PI_WEB_SESSIOND_DIR`
 *   3. {@link DEFAULT_SESSIOND_DIRECTORY}
 *
 * Pure and side-effect free so it stays usable from the narrow control surface.
 */
export function resolveRuntimeDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  const fromEnv = process.env[SESSIOND_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_SESSIOND_DIRECTORY;
}
