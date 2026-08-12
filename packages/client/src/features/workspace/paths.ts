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
 * These are pure functions; they never touch the network and never throw on
 * hostile input (they clamp / return null instead), so the boundary between
 * "what the UI offers" and "what the Host allows" stays defense-in-depth.
 */

/** Normalize platform separators to POSIX for consistent lexical reasoning. */
export function normalizeSeparators(input: string): string {
  return input.includes("\\") ? input.split("\\").join("/") : input;
}

/** Strip trailing separators (POSIX-normalized). Preserves a bare root "/". */
function stripTrailing(normalized: string): string {
  if (normalized === "/") return normalized;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** POSIX-style parent of an absolute path. Returns "/" at the filesystem root. */
function posixParent(normalized: string): string {
  const path = stripTrailing(normalized);
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** Trailing label of a path, used for the root crumb and file display. */
export function baseName(input: string): string {
  const path = stripTrailing(normalizeSeparators(input));
  if (path === "/" || path === "") return "/";
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? path.slice(1) || "/" : path.slice(idx + 1);
}

/**
 * True when `target` is equal to or lexically nested inside `root`, after
 * POSIX normalization. A root of "/" matches everything; otherwise the target
 * must equal root or start with `root + "/"`.
 */
export function isWithinRoot(target: string, root: string): boolean {
  const t = stripTrailing(normalizeSeparators(target));
  const r = stripTrailing(normalizeSeparators(root));
  if (r === "" || r === "/") return true;
  if (t === r) return true;
  return t.startsWith(`${r}/`);
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
  const base = stripTrailing(normalizeSeparators(parent));
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
}

/**
 * Parent of `dir`, clamped to `root`. Returns `null` when `dir` is already at
 * the root or its parent would escape the root — so the breadcrumb "up" button
 * can never offer a path outside the project root.
 */
export function parentWithinRoot(dir: string, root: string): string | null {
  if (!isWithinRoot(dir, root)) return null;
  const normalizedDir = stripTrailing(normalizeSeparators(dir));
  const normalizedRoot = stripTrailing(normalizeSeparators(root));
  if (normalizedDir === normalizedRoot) return null;
  const parent = posixParent(normalizedDir);
  return isWithinRoot(parent, normalizedRoot) ? parent : null;
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
  const normalizedRoot = stripTrailing(normalizeSeparators(root));
  const normalizedDir = stripTrailing(normalizeSeparators(dir));
  const rootLabel = baseName(normalizedRoot);
  const crumbs: Breadcrumb[] = [
    { label: rootLabel || "/", path: normalizedRoot },
  ];
  if (normalizedDir === normalizedRoot) return crumbs;
  const relative = normalizedDir.slice(normalizedRoot.length).replace(/^\/+/, "");
  let acc = normalizedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    acc = acc === "/" ? `/${segment}` : `${acc}/${segment}`;
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
  const f = stripTrailing(normalizeSeparators(from));
  const t = stripTrailing(normalizeSeparators(to));
  if (f === "" || f === "/" || t === f) return baseName(t);
  if (!t.startsWith(`${f}/`)) return baseName(t);
  return t.slice(f.length + 1);
}
