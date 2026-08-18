/**
 * @fffattiger/pix-sessiond — private-directory policy.
 *
 * Sessiond owns operational-vs-canonical split, leaf-symlink refusal, and
 * bounded identity re-verify. The filesystem walk itself lives in
 * `createSecureStateBackend().ensurePrivateDirectory` — sessiond must not
 * keep a second race implementation.
 */
import {
  createSecureStateBackend,
  LocalAuthorityError,
  type FileIdentity,
  type LocalAuthorityCode,
} from "@fffattiger/pix-local-authority/state";

/**
 * Frozen required private mode for the sessiond runtime directory. Existing
 * directories are NEVER silently chmod'd; a lax existing layout fails closed
 * with a fixed sanitized NOT_PRIVATE code and an operator remediation note.
 */
export const SESSIOND_PRIVATE_DIR_MODE = 0o700;

/**
 * Fixed sanitized messages for every local-authority code sessiond's private
 * directory preflight may throw. Never embed paths, errno text, or payloads.
 */
export const SESSIOND_PRIVATE_DIR_MESSAGES: Record<LocalAuthorityCode, string> = {
  INVALID_PATH: "sessiond private directory path is invalid",
  ROOT_PATH: "sessiond private directory must not be the filesystem root",
  PARENT_ESCAPE: "sessiond private directory path is unsafe",
  UNSAFE_COMPONENT: "sessiond private directory could not be verified",
  WINDOWS_PATH: "sessiond private directory path is invalid",
  NETWORK_PATH: "sessiond private directory path is invalid",
  UNSUPPORTED_PLATFORM: "sessiond secure state is unavailable on this platform",
  NOT_DIRECTORY: "sessiond private directory path is not a directory",
  SYMLINK: "sessiond private directory must not contain symbolic links",
  NOT_OWNED: "sessiond private directory must be owned by the current user",
  NOT_PRIVATE:
    "sessiond private directory must be private (sessiond never modifies existing directories; fix the directory and retry)",
  NOT_REGULAR: "sessiond private directory could not be verified",
  DOC_SYMLINK: "sessiond private directory could not be verified",
  DOC_UNREADABLE: "sessiond private directory could not be verified",
  DOC_OVERSIZE: "sessiond private directory could not be verified",
  DOC_PERMISSIONS: "sessiond private directory could not be verified",
  DOC_HARD_LINK: "sessiond private directory could not be verified",
  WRITE_FAILED: "sessiond private directory could not be verified",
  DIR_FSYNC_FAILED: "sessiond private directory could not be verified",
  LOCK_UNSAFE: "sessiond private directory could not be verified",
  LOCK_BUSY: "sessiond private directory could not be verified",
  LOCK_STALE: "sessiond private directory could not be verified",
  LOCK_LOST: "sessiond private directory could not be verified",
  LOCK_AMBIGUOUS: "sessiond private directory could not be verified",
  ALREADY_EXISTS: "sessiond private directory could not be verified",
};

/**
 * The preflighted sessiond private directory. The daemon creates its lock,
 * secret and sockets inside `operationalPath` (the original, shorter path —
 * keeping the AF_UNIX socket within the platform sun_path budget on macOS
 * `/var`), while the secure walk runs on `canonicalPath`.
 */
export interface SessiondPrivateDirectory {
  readonly canonicalPath: string;
  readonly operationalPath: string;
  readonly created: boolean;
  readonly identity: FileIdentity;
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (left.kind !== right.kind || !left.isDirectory || !right.isDirectory) return false;
  if (left.kind === "posix" && right.kind === "posix") {
    return !left.isSymbolicLink && !right.isSymbolicLink && left.dev === right.dev && left.ino === right.ino;
  }
  if (left.kind === "windows" && right.kind === "windows") {
    return !left.isReparsePoint && !right.isReparsePoint
      && left.volumeSerial === right.volumeSerial
      && left.fileId === right.fileId;
  }
  return false;
}

function remapPrivateDirectoryError(error: unknown): never {
  if (error instanceof LocalAuthorityError) {
    throw new LocalAuthorityError(error.code, SESSIOND_PRIVATE_DIR_MESSAGES[error.code]);
  }
  throw error;
}

export async function ensureSessiondPrivateDirectory(directory: string): Promise<SessiondPrivateDirectory> {
  const backend = createSecureStateBackend();
  try {
    const existing = await backend.fileIdentity(directory);
    if (existing?.kind === "posix" && existing.isSymbolicLink) {
      throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
    }
    if (existing?.kind === "windows" && existing.isReparsePoint) {
      throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
    }
    const canonical = await backend.canonicalizePath(directory);
    const result = await backend.ensurePrivateDirectory(canonical, {
      requireMode: SESSIOND_PRIVATE_DIR_MODE,
    });
    return {
      canonicalPath: result.path,
      operationalPath: directory,
      created: result.created,
      identity: result.identity,
    };
  } catch (error) {
    remapPrivateDirectoryError(error);
  }
}

/**
 * Bounded re-verify that the operational directory is still the preflighted
 * directory. The lstat and the caller's subsequent mutation are not atomic.
 */
export async function reverifySessiondPrivateDirectory(ctx: SessiondPrivateDirectory): Promise<void> {
  const backend = createSecureStateBackend();
  const identity = await backend.fileIdentity(ctx.operationalPath);
  if (identity === null || !sameDirectoryIdentity(identity, ctx.identity)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
}
