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
 * Normalize a filesystem-reported path (realpath output) into the form that
 * is stored and returned: extended prefixes stripped, win32 separators
 * resolved. Case is preserved — NTFS folding belongs to {@link pathKey}, not
 * to the path callers stat, display, and persist. POSIX: the exact input.
 */
export function canonicalizeRealpath(value: string, platform: PathPlatform = process.platform): string {
  if (!isWin(platform)) return value;
  return win32.resolve(stripExtendedPrefix(value));
}

/**
 * Comparison key for two independently produced absolute paths (resolve vs
 * realpath, caller-supplied vs canonical). Drive/UNC paths fold case and
 * separators on win32; POSIX keys stay exact.
 */
export function pathKey(value: string, platform: PathPlatform = process.platform): string {
  const canonical = canonicalizeRealpath(value, platform);
  return isWin(platform) ? canonical.toLowerCase() : canonical;
}

/** True when both paths name the same file (case/separator/prefix tolerant). */
export function samePath(a: string, b: string, platform: PathPlatform = process.platform): boolean {
  if (a === b) return true;
  if (!isWin(platform)) return false;
  return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * Ledger identity integers (dev/ino) survive a JSON round-trip exactly.
 *
 * NTFS reports the 64-bit file index as `ino`; as a JS Number it routinely
 * exceeds Number.MAX_SAFE_INTEGER, so `isSafeInteger` parse checks would mark
 * every record the host just wrote as sparse. Stored form: a Number when it
 * is a safe integer (POSIX ledgers keep their exact historical shape), else
 * the exact decimal string. Parse accepts both; compare through BigInt.
 */
export type StoredInteger = number | string;

export function storeInteger(value: bigint): StoredInteger {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) && BigInt(asNumber) === value ? asNumber : value.toString();
}

export function parseStoredInteger(value: unknown): bigint | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && Number.isInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
}

/** Exact equality of two stored (or freshly captured) identity integers. */
export function sameInteger(a: unknown, b: unknown): boolean {
  const left = typeof a === "bigint" ? a : parseStoredInteger(a);
  const right = typeof b === "bigint" ? b : parseStoredInteger(b);
  return left !== undefined && right !== undefined && left === right;
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
  // The separator follows the ARGUMENT platform, not the runtime one: the
  // darwin/linux branch must test `/` even when the test runs on win32.
  if (!isWin(platform)) return child.startsWith(`${root}/`);
  const childKey = pathKey(child, platform);
  const rootKey = pathKey(root, platform);
  return childKey === rootKey || childKey.startsWith(`${rootKey}\\`);
}
