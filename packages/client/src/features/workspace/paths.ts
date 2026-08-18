/**
 * Read-only workspace path helpers.
 *
 * The Host (allowed-roots service) is the authority that canonicalizes and
 * authorizes every absolute path we send. These helpers exist so the *client*
 * never constructs or offers a path that escapes the project root on its own:
 *
 *  - The project root is the canonical current working directory (the Host
 *    returns it as `path` on a directory listing). Breadcrumbs and the
 *    "parent" navigation are clamped to that root — the UI cannot walk above it.
 *  - Entering a directory only ever appends a single, validated entry name.
 *  - All reasoning is done against POSIX-normalized segments so a symlinked
 *    macOS prefix (e.g. `/var` → `/private/var`) cannot split a canonical path
 *    away from its own canonical root.
 *
 * Drive-root / case-fold / containment live in `@/lib/file-paths`. This module
 * only owns workspace navigation. These are pure functions; they never touch
 * the network and never throw on hostile input (they clamp / return null
 * instead), so the boundary between "what the UI offers" and "what the Host
 * allows" stays defense-in-depth.
 */

import {
  filePathCompareKey,
  isFilePathInside,
  isWindowsDriveRootPath,
  joinFilePath,
  keepWindowsDriveRoot,
  normalizeClientPath,
} from "@/lib/file-paths";

function normalizeWorkspacePath(input: string): string {
  return keepWindowsDriveRoot(normalizeClientPath(input));
}

/** Parent of an absolute path. Drive roots stay `C:/`; POSIX root stays `/`. */
function posixParent(normalized: string): string {
  const path = normalizeWorkspacePath(normalized);
  if (path === "/" || isWindowsDriveRootPath(path)) return path;
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  const parent = path.slice(0, idx);
  return isWindowsDriveRootPath(`${parent}/`) ? `${parent}/` : parent;
}

/** Trailing label of a path, used for the root crumb and file display. */
export function baseName(input: string): string {
  const path = normalizeWorkspacePath(input);
  if (path === "/" || path === "") return "/";
  if (isWindowsDriveRootPath(path)) return path;
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? path.slice(1) || "/" : path.slice(idx + 1);
}

/**
 * True when `target` is equal to or lexically nested inside `root`, after
 * POSIX normalization. A root of "/" matches everything. Windows drive paths
 * compare case-insensitively; a drive root (`C:/`) does not collapse to `C:`.
 */
export function isWithinRoot(target: string, root: string): boolean {
  return isFilePathInside(target, root);
}

/**
 * Join a canonical parent directory with a single entry name. Rejects any name
 * that could escape the parent (separator, traversal segment, or empty), so the
 * UI can never synthesize a path like `/root/../etc`. The result is the
 * parent/name pair (still subject to Host canonicalization when listed).
 *
 * @throws Error if `name` contains a separator, is `.`/`..`, or is empty.
 */
export function joinChild(parent: string, name: string): string {
  if (!name) throw new Error("Invalid entry name: empty");
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid entry name: must not contain a path separator");
  }
  if (name === "." || name === "..") {
    throw new Error("Invalid entry name: traversal segments are not allowed");
  }
  return joinFilePath(parent, name);
}

/**
 * Join the canonical project root with a Host-returned *relative* POSIX file
 * path (e.g. `sub/a.ts`) from a file-index match. The Host produces these
 * relative to the authorized root, but the client still validates every
 * segment defensively: empty/`.`/`..` segments, NUL, backslash, a leading
 * slash (absolute) and repeated/trailing slashes are all rejected with `null`.
 * The joined result is then re-checked with `isWithinRoot` so a crafted match
 * can never resolve to a path outside the canonical root. Uses the existing
 * pure path helpers — never URL/path library platform differences.
 *
 * @returns the absolute joined path, or `null` when `rel` is hostile/malformed.
 */
export function joinRelative(root: string, rel: string): string | null {
  if (!rel) return null;
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (rel.startsWith("/") || rel.endsWith("/")) return null;
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  const base = normalizeWorkspacePath(root);
  if (base === "") return null;
  const joined = joinFilePath(base, rel);
  return isWithinRoot(joined, base) ? joined : null;
}

/**
 * Parent of `dir`, clamped to `root`. Returns `null` when `dir` is already at
 * the root or its parent would escape the root — so the breadcrumb "up" button
 * can never offer a path outside the project root.
 */
export function parentWithinRoot(dir: string, root: string): string | null {
  if (!isWithinRoot(dir, root)) return null;
  const normalizedDir = normalizeWorkspacePath(dir);
  const normalizedRoot = normalizeWorkspacePath(root);
  if (filePathCompareKey(normalizedDir) === filePathCompareKey(normalizedRoot)) return null;
  const parent = posixParent(normalizedDir);
  if (!isWithinRoot(parent, normalizedRoot)) return null;
  if (isWindowsDriveRootPath(parent) && filePathCompareKey(parent) === filePathCompareKey(normalizedRoot)) {
    return normalizedRoot;
  }
  return parent;
}

export interface Breadcrumb {
  label: string;
  path: string;
}

/**
 * Build breadcrumbs from `root` down to `dir`. The root is always the first
 * crumb (labeled with its base name). Returns an empty list when `dir` is not
 * within `root`, so the UI never renders a breadcrumb chain that leaves root.
 */
export function breadcrumbs(dir: string, root: string): Breadcrumb[] {
  if (!isWithinRoot(dir, root)) return [];
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedDir = normalizeWorkspacePath(dir);
  const rootLabel = baseName(normalizedRoot);
  const crumbs: Breadcrumb[] = [
    { label: rootLabel || "/", path: normalizedRoot },
  ];
  if (filePathCompareKey(normalizedDir) === filePathCompareKey(normalizedRoot)) return crumbs;
  const relative = normalizedDir.slice(normalizedRoot.length).replace(/^\/+/, "");
  let acc = normalizedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    acc = joinFilePath(acc, segment);
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

/**
 * Best-effort relative path from `from` to `to` for display (e.g. a git file
 * path relative to the repository root). Falls back to `to`'s base name when the
 * two are not in a parent/child relationship, so display never leaks an
 * unrelated absolute path.
 */
export function relativePath(from: string, to: string): string {
  const f = normalizeWorkspacePath(from);
  const t = normalizeWorkspacePath(to);
  if (f === "" || f === "/") return baseName(t);
  if (filePathCompareKey(t) === filePathCompareKey(f)) return baseName(t);
  const prefix = isWindowsDriveRootPath(f) ? filePathCompareKey(f) : `${filePathCompareKey(f)}/`;
  if (!filePathCompareKey(t).startsWith(prefix)) return baseName(t);
  return t.slice(f.length + (isWindowsDriveRootPath(f) ? 0 : 1));
}
