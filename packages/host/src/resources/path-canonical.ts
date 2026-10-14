/**
 * Host-side canonical path comparison primitives for cross-platform roots.
 *
 * Two Windows realities the `/`-world comparisons miss:
 *   1. `fs.realpath` variants may return extended-length prefixes
 *      (`\\?\C:\…`, `\\?\UNC\server\share\…`); those strings never compare
 *      equal to `path.resolve` outputs even though they name the same file.
 *   2. NTFS is case-insensitive: `C:\Repo` and `c:\repo` are the same root,
 *      but string/`startsWith` comparisons call them different.
 *
 * POSIX behavior is exact-string (frozen): the helpers are identity there.
 * Platform is injectable (default `process.platform`) so the win32 semantics
 * are unit-testable on macOS/Linux.
 */
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

type PathPlatform = NodeJS.Platform | string;

const isWin = (platform: PathPlatform): boolean => platform === "win32";

/** Strip `\\?\` / `\\?\UNC\` extended-length prefixes from a win32 path. */
export function stripExtendedPrefix(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\${value.slice(7)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

/**
 * Normalize a filesystem-reported path (realpath output) into the canonical
 * key space: extended prefixes stripped; on win32 also resolved and folded to
 * lowercase. POSIX: the exact input (frozen).
 */
export function canonicalizeRealpath(value: string, platform: PathPlatform = process.platform): string {
  if (!isWin(platform)) return value;
  return win32.resolve(stripExtendedPrefix(value)).toLowerCase();
}

/**
 * Comparison key for two independently produced absolute paths (resolve vs
 * realpath, caller-supplied vs canonical). Drive/UNC paths fold case and
 * separators on win32; POSIX keys stay exact.
 */
export function pathKey(value: string, platform: PathPlatform = process.platform): string {
  return canonicalizeRealpath(value, platform);
}

/** True when both paths name the same file (case/separator/prefix tolerant). */
export function samePath(a: string, b: string, platform: PathPlatform = process.platform): boolean {
  if (a === b) return true;
  if (!isWin(platform)) return false;
  return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * True when `target` is `root` itself or a lexical child of it. Prefix-safe
 * (`C:\repo-evil` is NOT inside `C:\repo`), separator-safe, case-tolerant on
 * win32, and immune to extended-prefix inputs.
 */
export function pathWithin(root: string, target: string, platform: PathPlatform = process.platform): boolean {
  const normalizedRoot = stripExtendedPrefix(root);
  const normalizedTarget = stripExtendedPrefix(target);
  if (isWin(platform)) {
    const rel = win32.relative(win32.resolve(normalizedRoot), win32.resolve(normalizedTarget));
    if (rel === "") return true;
    return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !win32.isAbsolute(rel);
  }
  const rel = relative(resolve(normalizedRoot), resolve(normalizedTarget));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True when `child` equals `root` or starts with `root` + one separator, with
 * win32 case/extended-prefix tolerance. For roots where the child is already
 * known to be lexically derived from the root (static asset resolution).
 */
export function isPathOrChildOf(child: string, root: string, platform: PathPlatform = process.platform): boolean {
  if (child === root) return true;
  if (!isWin(platform)) return child.startsWith(`${root}${sep}`);
  const childKey = pathKey(child, platform);
  const rootKey = pathKey(root, platform);
  return childKey === rootKey || childKey.startsWith(`${rootKey}\\`);
}
