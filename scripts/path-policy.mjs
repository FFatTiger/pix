// scripts/path-policy.mjs
//
// Shared path comparison/containment for root tooling. Production helpers and
// tests must not hard-code POSIX `/` or Windows `\` when deciding whether one
// path is inside another: separators, drive-root forms, sibling prefixes,
// spaces, and (on Windows) ASCII case must compare consistently.

/** Convert native separators to `/` for comparison and fixture reporting. */
export function toPosixPath(path) {
  return String(path).replace(/\\/g, "/");
}

/**
 * Platform comparison form: `/` separators, no trailing slash except a lone
 * `/`, and case-folded on win32. Drive roots such as `C:\` become `c:`.
 */
export function pathCompareForm(path) {
  const posix = toPosixPath(path);
  const folded = process.platform === "win32" ? posix.toLowerCase() : posix;
  if (folded === "/") return "/";
  return folded.replace(/\/+$/, "");
}

/**
 * True when `child` equals `parent` or is strictly beneath it.
 * Sibling prefixes (`/a/b` vs `/a/bc`) are rejected. Mixed separators are
 * equivalent. Windows comparison is case-insensitive.
 */
export function isWithin(parent, child) {
  const p = pathCompareForm(parent);
  const c = pathCompareForm(child);
  if (p === c) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

/** POSIX-style path relative to `rootDir` (leading segment, `/` separators). */
export function toPosixRelative(rootDir, file) {
  const root = toPosixPath(rootDir);
  const full = toPosixPath(file);
  if (full === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (full.startsWith(prefix)) return full.slice(prefix.length);
  if (process.platform === "win32") {
    const rootFolded = root.toLowerCase();
    const fullFolded = full.toLowerCase();
    const foldedPrefix = rootFolded.endsWith("/") ? rootFolded : `${rootFolded}/`;
    if (fullFolded.startsWith(foldedPrefix)) return full.slice(foldedPrefix.length);
  }
  return full;
}
