/**
 * @fffattiger/pix-local-authority — platform-aware absolute-path primitives.
 *
 * The secure-state backend is POSIX-frozen; win32 support needs the same
 * fail-closed walk semantics over drive-letter (`C:\…`) and UNC
 * (`\\server\share\…`) roots. This module centralizes, for BOTH platforms:
 *
 *   - platform selection (`process.platform` by default, injectable for tests
 *     so win32 semantics are unit-testable on macOS/Linux);
 *   - absolute-path decomposition into a root + validated segments (no
 *     `.` / `..` / empty / NUL / control chars), generalizing the frozen
 *     `/`-rooted POSIX walk to drive/UNC roots;
 *   - canonical comparison keys: win32 realpath results may carry `\\?\` /
 *     `\\?\UNC\` extended prefixes and NTFS is case-insensitive, so equality
 *     checks strip the prefix and fold case (POSIX keys stay exact strings —
 *     frozen behavior).
 *
 * Windows privacy note (documented residual, see docs/windows.md): NTFS has no
 * POSIX mode bits; the secure directory relies on the user-profile ACL
 * inheritance instead of 0700 enforcement, keeps symlink/junction rejection
 * (libuv reports junctions as symlinks) and dev/ino identity pinning (NTFS
 * file index). Windows device paths (`\\.\…`, `\\?\…`) are rejected as
 * canonical targets; the `\\?\` *file* prefixes produced by realpath variants
 * are stripped before comparison/normalization.
 */
import { posix, win32 } from "node:path";
import { LocalAuthorityError } from "./contracts.js";

/** Platform modes the secure-state walk understands. */
export type SecurePathPlatform = "posix" | "win32";

/** Map a Node platform name onto the secure-path mode (default `process.platform`). */
export function securePathPlatform(platform: string = process.platform): SecurePathPlatform {
  return platform === "win32" ? "win32" : "posix";
}

/** The `node:path` API of the selected platform (pure; usable on any host). */
export function securePathApi(platform: SecurePathPlatform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

/** Drive-letter root shape (`C:\`) after win32 normalization. */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\$/;

/**
 * Strip `\\?\` and `\\?\UNC\` extended-length prefixes from a win32 path
 * (realpath variants may produce them; canonical storage never keeps them).
 * `\\?\UNC\server\share` maps back to `\\server\share`.
 */
export function stripWindowsExtendedPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\${path.slice(7)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** Decomposed absolute path: a validated root plus non-empty literal segments. */
export interface DecomposedAbsolutePath {
  /** Root prefix: `/`, `C:\`, or `\\server\share`. Never empty. */
  root: string;
  /** Literal segments (no separators, no `.` / `..` / empty). */
  segments: string[];
}

/**
 * Decompose an absolute path per platform. POSIX input must be `/`-rooted
 * (drive/UNC/network claims fail closed exactly like the frozen walk). Win32
 * input must be drive- or UNC-rooted after extended-prefix stripping; device
 * paths (`\\.\pipe\…`) fail closed. Throws the fixed LocalAuthorityError codes
 * the callers already map (INVALID_PATH / PARENT_ESCAPE / UNSAFE_COMPONENT).
 */
export function decomposeAbsolutePath(path: string, platform: SecurePathPlatform): DecomposedAbsolutePath {
  if (platform === "posix") {
    if (!path.startsWith("/")) {
      if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
        throw new LocalAuthorityError("WINDOWS_PATH", "Windows drive-letter paths are not supported");
      }
      throw new LocalAuthorityError("INVALID_PATH", "Path must be absolute");
    }
    if (path.startsWith("//")) {
      throw new LocalAuthorityError("NETWORK_PATH", "Network share paths are not supported");
    }
    const root = "/";
    const segments = path.slice(1).split("/").filter((segment) => segment.length > 0);
    validateSegments(segments);
    return { root, segments };
  }
  const stripped = stripWindowsExtendedPrefix(path);
  // Device paths (\\.\pipe\\…, \\?\\…) are never canonical targets; reject
  // them first so their `.`/`?` server component is not mistaken for a segment.
  if (/^\\\\[.?]/.test(stripped)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be drive- or UNC-rooted");
  }
  if (!win32.isAbsolute(stripped)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be absolute");
  }
  // `/`-rooted inputs are cwd-DRIVE-relative on win32 (resolve anchors them to
  // the current drive) — fail closed instead of accepting drive-dependent paths.
  if (!/^\\\\/.test(stripped) && !/^[A-Za-z]:[\\/]/.test(stripped)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be drive- or UNC-rooted");
  }
  // Reject lexical parent/current escapes BEFORE normalization (never silently
  // resolve `..` — same frozen rule as the POSIX branch).
  validateSegments(stripped.split(/[\\/]+/));
  const normalized = win32.resolve(stripped);
  const parsed = win32.parse(normalized);
  let root = parsed.root;
  if (WINDOWS_DRIVE_ROOT.test(root)) {
    if (normalized === root) return { root, segments: [] };
    const segments = normalized.slice(root.length).split("\\").filter((segment) => segment.length > 0);
    validateSegments(segments);
    return { root, segments };
  }
  // UNC root: `\\server\share` (win32.parse sometimes reports only `\`).
  const uncPrefix = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+/;
  const match = uncPrefix.exec(normalized);
  // Device-path prefixes (server component "." or "?") masquerade as UNC after
  // extended-prefix stripping; they are rejected so device paths fail closed.
  if (match === null || /^\\\\[.?]/.test(normalized)) {
    // Device paths (\\.\…) and malformed roots fail closed.
    throw new LocalAuthorityError("INVALID_PATH", "Path must be drive- or UNC-rooted");
  }
  root = match[0];
  if (normalized === root || normalized === `${root}\\`) return { root, segments: [] };
  const segments = normalized.slice(root.length).replace(/^\\+/, "").split("\\").filter((segment) => segment.length > 0);
  validateSegments(segments);
  return { root, segments };
}

function validateSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Path must not contain parent or current directory components");
    }
    if (segment.includes("\0")) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component is unsafe");
    }
  }
}

/** True when the decomposed path names a filesystem root (no segments). */
export function isFilesystemRoot(decomposed: DecomposedAbsolutePath): boolean {
  return decomposed.segments.length === 0;
}

/**
 * Canonical comparison key for equality checks against realpath results.
 * POSIX: the exact string (frozen behavior). Win32: extended prefixes
 * stripped, win32-normalized, lowercased (NTFS case-insensitivity).
 */
export function canonicalCompareKey(path: string, platform: SecurePathPlatform): string {
  if (platform === "posix") return path;
  return stripWindowsExtendedPrefix(path).toLowerCase();
}
