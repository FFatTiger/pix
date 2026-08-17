/**
 * @fffattiger/pix-sessiond — POSIX private-directory hardening (slice).
 *
 * Sessiond keeps its OWN private-directory policy (secret no-overwrite
 * publication, dead-pid stale-lock recovery, private socket alias rules,
 * instance-lock semantics). It reuses ONLY the canonical/error/identity
 * primitives from `@fffattiger/pix-local-authority/state` — never its
 * `ensurePrivateDirectory` walk (sessiond policy differs) and never its
 * document/lock backends.
 *
 * Frozen semantics (sessiond policy, mirrors the Local Authority walk §55/§55.1):
 *   - preflight of the runtime directory holding secret/lock/socket:
 *       missing → create component-by-component 0700; the created leaf is
 *         pinned by fd identity (fstat dev/ino BEFORE fchmod, fstat AFTER, and
 *         a final pathname re-lstat + realpath) so a swapped-in real directory
 *         is never silently chmod'd;
 *       existing → validate-only: exact current-user owner (where supported),
 *         exact required mode (0o700), real non-symlink directory. NEVER
 *         silently chmod'd; a lax existing layout fails closed with a fixed
 *         sanitized NOT_PRIVATE code and an operator remediation note.
 *   - no symlink intermediates/leaf (macOS `/var` → `/private/var` system alias
 *     is resolved by canonicalization, not false-rejected).
 *   - after preflight, each critical daemon step re-verifies the directory
 *     identity (dev/ino) has not been swapped before mutating inside it
 *     (bounded re-verify via {@link reverifySessiondPrivateDirectory}).
 *
 * Residual (Node has no openat; same-UID actor on a shared parent): the same
 * TWO windows documented for Local Authority §55.1 apply to a CREATED leaf —
 * (1) a swap between the fulfilled leaf mkdir and the immediate identity-capture
 * lstat captures the replacement's identity, (2) a swap after the final
 * pathname re-lstat/realpath (handle closed, no openat to re-pin). Additionally
 * the bounded re-verify lstat and the subsequent mutation are not atomic: a
 * same-UID swap between the re-verify and the actual open is a documented
 * residual window, NOT claimed fail-closed. Cross-user boundaries are never
 * weakened.
 */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  canonicalizeAbsolutePath,
  currentPrincipal,
  hasControlChar,
  isOwnedByCurrentUser,
  LocalAuthorityError,
  posixFileIdentity,
  type LocalAuthorityCode,
  type PosixFileIdentity,
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
 * Used both when throwing (here) and when mapping to the daemon's fixed
 * {@link SessiondError} surface (composition/daemon.ts), so the two never
 * drift. Codes outside the directory walk (document/lock codes) map to a
 * generic fail-closed message; they are never thrown by this module.
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
    "sessiond private directory mode must be 0700 (sessiond never modifies existing directories; fix the mode and retry)",
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
};

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Convert a raw lstat `Stats`-shaped object into a stable identity. */
function toIdentity(info: {
  dev: number; ino: number; mode: number; nlink: number; size: number; uid: number; gid: number;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}): PosixFileIdentity {
  return {
    kind: "posix",
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    size: info.size,
    uid: info.uid,
    gid: info.gid,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    isSymbolicLink: info.isSymbolicLink(),
  };
}

/**
 * The preflighted sessiond private directory. The daemon creates its lock,
 * secret and sockets inside `operationalPath` (the original, shorter path —
 * keeping the AF_UNIX socket within the platform sun_path budget on macOS
 * `/var`), while the secure walk runs on `canonicalPath` (realpath-resolved,
 * symlink-free). Both name the same directory inode; {@link
 * reverifySessiondPrivateDirectory} re-lstats the operational path and pins it
 * to `identity` before every critical mutation.
 */
export interface SessiondPrivateDirectory {
  /** Canonical (realpath-resolved) absolute path used for the secure walk. */
  readonly canonicalPath: string;
  /** The operational path the daemon uses for lock/secret/socket paths. */
  readonly operationalPath: string;
  /** True when the final leaf was newly created by this call (0700 via fd). */
  readonly created: boolean;
  /** Stable identity (dev/ino/uid/gid/mode) of the directory leaf. */
  readonly identity: PosixFileIdentity;
}

/**
 * Narrow fs dependency set injected into the secure-directory walk so tests can
 * deterministically force the exact ENOENT → mkdir EEXIST race sequence and the
 * fd-identity swap (same seam pattern as Local Authority §55). Production
 * injects the real fs via {@link ensureSessiondPrivateDirectory}. This is a
 * private/internal seam: it is exported from this module for tests but never
 * re-exported from the public sessiond surfaces (index/control/composition).
 */
interface EnsurePrivateDirectoryFs {
  lstat: (path: string) => Promise<Stats>;
  // The walk ignores mkdir's return value; typed `Promise<unknown>` so the real
  // `mkdir(path, { recursive:false })` (Promise<void>) and injected fakes both fit.
  mkdir: (path: string, options: { recursive: false; mode: number }) => Promise<unknown>;
  realpath: (path: string) => Promise<string>;
  open: (path: string, flags: number) => Promise<OpenedDirectoryHandle>;
  isOwnedByCurrentUser: (identity: PosixFileIdentity) => boolean;
}

/**
 * Minimal handle surface the secure-directory walk requires from an opened
 * directory handle. The real `FileHandle` satisfies this structurally; tests can
 * inject a controlled handle. `stat` (fstat on the fd) is REQUIRED — it is how
 * the walk pins the inode it created BEFORE chmod: O_NOFOLLOW alone cannot stop
 * a real directory swapped in for the pathname, only the fd identity can.
 */
interface OpenedDirectoryHandle {
  stat: () => Promise<Stats>;
  chmod: (mode: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Secure private-directory walk (sessiond policy). Mirrors the Local Authority
 * walk (§55/§55.1) semantics, adapted:
 *   - existing components must be real non-symlink directories;
 *   - on first ENOENT, each remaining component is mkdir'd
 *     `recursive:false` 0700; ONLY a fulfilled mkdir counts as "created by this
 *     call" — a swallowed EEXIST is raced/preplanted, never created, never
 *     chmod'd, and takes the existing-leaf validate-only path (final leaf) or
 *     the strong raced-intermediate policy (missing tail);
 *   - a newly created leaf is pinned by fd identity (fstat dev/ino BEFORE
 *     chmod, fstat AFTER, and a final pathname re-lstat + realpath);
 *   - an existing leaf is NEVER chmod'd: current-user owner (where supported),
 *     exact 0o700 mode, real non-symlink directory.
 *
 * TEST-ONLY EXPORT: reachable only via the direct module path
 * `src/local-posix.js` (not re-exported from index/control/composition).
 */
export async function ensureSessiondPrivateDirectoryWithFs(
  path: string,
  fs: EnsurePrivateDirectoryFs,
): Promise<{ path: string; created: boolean; identity: PosixFileIdentity }> {
  const requireOwnedByCurrentUser = currentPrincipal().uid !== undefined;
  const normalized = resolve(path);
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\0")
    || hasControlChar(path)
    || !isAbsolute(path)
  ) {
    throw new LocalAuthorityError("INVALID_PATH", SESSIOND_PRIVATE_DIR_MESSAGES.INVALID_PATH);
  }
  if (normalized === "/") {
    throw new LocalAuthorityError("ROOT_PATH", SESSIOND_PRIVATE_DIR_MESSAGES.ROOT_PATH);
  }

  const segments = normalized === "/"
    ? []
    : normalized.slice(1).split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", SESSIOND_PRIVATE_DIR_MESSAGES.PARENT_ESCAPE);
    }
    if (segment.includes("\0") || segment.includes("/")) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
    }
  }

  let current = "/";
  let creating = false;
  // True ONLY when THIS call's mkdir(recursive:false, 0700) fulfilled the final
  // leaf component. Never derived from pathname equality alone — a raced EEXIST
  // leaf must not be treated as created.
  let leafCreated = false;
  // dev/ino identity of the inode THIS call created for the final leaf,
  // captured immediately after the successful leaf mkdir. Pinned reference for
  // the fd-based verification before/after chmod and the final pathname re-lstat.
  let createdIdentity: { dev: number; ino: number } | null = null;
  // dev/ino identity of an accepted raced intermediate, re-verified before each
  // descendant is created (fail closed on any swap).
  let racedParent: { path: string; dev: number; ino: number } | null = null;

  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    const isLeaf = current === normalized;

    if (racedParent !== null) {
      let parentInfo;
      try {
        parentInfo = await fs.lstat(racedParent.path);
      } catch {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
      }
      if (
        parentInfo.isSymbolicLink()
        || !parentInfo.isDirectory()
        || parentInfo.dev !== racedParent.dev
        || parentInfo.ino !== racedParent.ino
      ) {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
      }
      racedParent = null;
    }

    if (!creating) {
      let info;
      try {
        info = await fs.lstat(current);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
        }
        creating = true;
      }
      if (!creating) {
        if (info!.isSymbolicLink()) {
          throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
        }
        if (!info!.isDirectory()) {
          throw new LocalAuthorityError("NOT_DIRECTORY", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_DIRECTORY);
        }
        continue;
      }
    }

    // "creating" mode: try a non-recursive mkdir and classify the component
    // from the EXACT result — only a fulfilled mkdir is "created by this call".
    let mkdirFulfilled = false;
    try {
      await fs.mkdir(current, { recursive: false, mode: 0o700 });
      mkdirFulfilled = true;
    } catch (mkdirError) {
      if (errnoCode(mkdirError) !== "EEXIST") {
        throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
      }
    }

    let info;
    try {
      info = await fs.lstat(current);
    } catch {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
    }
    if (info.isSymbolicLink()) {
      throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
    }
    if (!info.isDirectory()) {
      throw new LocalAuthorityError("NOT_DIRECTORY", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_DIRECTORY);
    }

    if (mkdirFulfilled) {
      if (isLeaf) {
        leafCreated = true;
        createdIdentity = { dev: info.dev, ino: info.ino };
      }
      continue;
    }

    // EEXIST after an earlier ENOENT observation: raced/preplanted. NEVER
    // chmod'd; NEVER silently treated as created.
    if (!isLeaf) {
      // Raced missing-tail INTERMEDIATE: strong compatible policy — continue
      // only when it is a real non-symlink directory, owned by the current user
      // (where required), and exactly private; otherwise fail closed with zero
      // descendants. Its dev/ino is re-verified before the next descendant.
      if (requireOwnedByCurrentUser && !fs.isOwnedByCurrentUser(toIdentity(info))) {
        throw new LocalAuthorityError("NOT_OWNED", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_OWNED);
      }
      if ((info.mode & 0o777) !== SESSIOND_PRIVATE_DIR_MODE) {
        throw new LocalAuthorityError("NOT_PRIVATE", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_PRIVATE);
      }
      racedParent = { path: current, dev: info.dev, ino: info.ino };
      continue;
    }
    // Raced final leaf: leafCreated stays false → existing-leaf validate-only.
  }

  let finalInfo;
  try {
    finalInfo = await fs.lstat(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
  if (finalInfo.isSymbolicLink()) {
    throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
  }
  if (!finalInfo.isDirectory()) {
    throw new LocalAuthorityError("NOT_DIRECTORY", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_DIRECTORY);
  }

  if (leafCreated) {
    // Newly created leaf: enforce 0o700 via fd-based fchmod, but ONLY after the
    // opened handle is fstat-verified to be the exact inode THIS call created
    // (O_NOFOLLOW alone is not sufficient — it only refuses a SYMLINK). The
    // created identity must also match the last pre-open lstat. Never
    // path-chmod after a handle close.
    if (
      createdIdentity === null
      || createdIdentity.dev !== finalInfo.dev
      || createdIdentity.ino !== finalInfo.ino
    ) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
    }
    let dirHandle;
    try {
      dirHandle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await dirHandle.stat();
        if (
          !opened.isDirectory()
          || opened.dev !== createdIdentity.dev
          || opened.ino !== createdIdentity.ino
        ) {
          throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
        }
        await dirHandle.chmod(SESSIOND_PRIVATE_DIR_MODE);
        const after = await dirHandle.stat();
        if (
          !after.isDirectory()
          || after.dev !== createdIdentity.dev
          || after.ino !== createdIdentity.ino
          || (after.mode & 0o777) !== SESSIOND_PRIVATE_DIR_MODE
        ) {
          throw new LocalAuthorityError("NOT_PRIVATE", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_PRIVATE);
        }
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof LocalAuthorityError) throw error;
      throw new LocalAuthorityError("NOT_PRIVATE", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_PRIVATE);
    }
  } else {
    // Existing directory (pre-existing, or raced EEXIST leaf): NEVER chmod.
    if (requireOwnedByCurrentUser && !fs.isOwnedByCurrentUser(toIdentity(finalInfo))) {
      throw new LocalAuthorityError("NOT_OWNED", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_OWNED);
    }
    if ((finalInfo.mode & 0o777) !== SESSIOND_PRIVATE_DIR_MODE) {
      throw new LocalAuthorityError("NOT_PRIVATE", SESSIOND_PRIVATE_DIR_MESSAGES.NOT_PRIVATE);
    }
  }

  // Final re-lstat: still the same verified inode, so a replacement before
  // return fails closed.
  const verifiedDev = createdIdentity !== null ? createdIdentity.dev : finalInfo.dev;
  const verifiedIno = createdIdentity !== null ? createdIdentity.ino : finalInfo.ino;
  let finalRecheck;
  try {
    finalRecheck = await fs.lstat(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
  if (
    finalRecheck.isSymbolicLink()
    || !finalRecheck.isDirectory()
    || finalRecheck.dev !== verifiedDev
    || finalRecheck.ino !== verifiedIno
  ) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }

  // Final re-verify the leaf is still a real canonical non-symlink directory.
  let finalReal;
  try {
    finalReal = await fs.realpath(current);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
  if (finalReal !== current) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
  return { path: current, created: leafCreated, identity: toIdentity(finalRecheck) };
}

/** Real-fs injection for the production entry point. */
function realFs(): EnsurePrivateDirectoryFs {
  return { lstat, mkdir, realpath, open, isOwnedByCurrentUser };
}

/**
 * Preflight the sessiond private directory (production entry).
 *
 * Canonicalizes the absolute path (resolving the macOS `/var` system alias and
 * rejecting symlink intermediates), then walks it: missing components are
 * created 0700 (created leaf pinned via fd-based fchmod); an existing leaf is
 * validate-only (owner / exact 0o700 / real non-symlink directory) and NEVER
 * chmod'd. The daemon keeps operating on the original (short) path for lock /
 * secret / socket paths — the returned {@link SessiondPrivateDirectory} carries
 * both and the stable identity for {@link reverifySessiondPrivateDirectory}.
 */
export async function ensureSessiondPrivateDirectory(directory: string): Promise<SessiondPrivateDirectory> {
  // Reject a symlink at the OPERATIONAL leaf before any creation/validation: the
  // canonical walk would otherwise resolve it away (canonicalization resolves
  // pre-existing symlinks — including the macOS `/var` system alias as an
  // INTERMEDIATE — but a symlink LEAF of the runtime directory is refused so
  // sessiond never publishes secret/lock/socket through a symlinked leaf).
  let operationalLeaf;
  try {
    operationalLeaf = await lstat(directory);
  } catch {
    operationalLeaf = undefined; // missing → the walk creates it as a real dir
  }
  if (operationalLeaf !== undefined && operationalLeaf.isSymbolicLink()) {
    throw new LocalAuthorityError("SYMLINK", SESSIOND_PRIVATE_DIR_MESSAGES.SYMLINK);
  }
  const canonical = await canonicalizeAbsolutePath(directory);
  const result = await ensureSessiondPrivateDirectoryWithFs(canonical, realFs());
  return {
    canonicalPath: canonical,
    operationalPath: directory,
    created: result.created,
    identity: result.identity,
  };
}

/**
 * Bounded re-verify that the operational directory is STILL the preflighted
 * directory (same dev/ino, real non-symlink directory). Called immediately
 * before each critical mutation inside it (instance-lock create, secret
 * publish, socket bind/publication). Throws a fixed sanitized
 * {@link LocalAuthorityError} (UNSAFE_COMPONENT) on any change. The lstat and
 * the caller's subsequent mutation are not atomic — a same-UID swap between
 * them is a documented residual window (Node has no openat), not claimed
 * fail-closed.
 */
export async function reverifySessiondPrivateDirectory(ctx: SessiondPrivateDirectory): Promise<void> {
  const identity = await posixFileIdentity(ctx.operationalPath);
  if (
    identity === null
    || identity.isSymbolicLink
    || !identity.isDirectory
    || identity.dev !== ctx.identity.dev
    || identity.ino !== ctx.identity.ino
  ) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", SESSIOND_PRIVATE_DIR_MESSAGES.UNSAFE_COMPONENT);
  }
}
