// scripts/remove-paths.mjs
//
// Cross-platform safe replacement for `rm -rf` used by package.json clean /
// build:test scripts. npm runs scripts through cmd.exe on Windows, where Unix
// `rm` does not exist; Node 22+ `fs.rmSync` is portable.
//
// Safety contract:
//   - Only the explicitly supplied paths (relative to cwd) are removed.
//   - Rejects empty / NUL-containing / root / drive-root / UNC-root paths,
//     the working directory itself, and any path whose exact resolved
//     location escapes the cwd (parent escape or symlink escape).
//   - Never follows a symlink target: `fs.rm` removes a top-level symlink as
//     a link (the target survives), and a resolved path that reaches through
//     an escaping symlink component is rejected before any removal.
//   - Transient Windows EPERM/EBUSY/ENOTEMPTY is retried with Node's bounded
//     `maxRetries`/`retryDelay`; a persistent failure exits nonzero with a
//     sanitized message (no stack dump).

import { lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Bounded retry for Windows transient lock errors (EBUSY/EPERM/ENOTEMPTY). */
export const RETRY = { maxRetries: 5, retryDelay: 100 };

// A lexical drive path (`C:`, `C:\`, `C:\foo`, `C:/foo`) is never a safe
// relative target: on win32 it is absolute, elsewhere it is a meaningless
// artifact. UNC roots (`\\server\share`) are rejected the same way.
const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;
const UNC_ROOT = /^\\\\[^\\]+\\[^\\]*[\\/]?$/;

function eq(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * True when `child` equals `parent` or is strictly beneath it.
 *
 * The separator is taken from the paths themselves, not from `path.sep`:
 * callers compare both native paths (`C:\a\b`) and POSIX-style probes
 * (`/a/b`) on every platform, and a native separator would make the POSIX
 * form never match on Windows.
 */
export function isWithin(parent, child) {
  const slash = parent.includes("/") || child.includes("/");
  const back = parent.includes("\\") || child.includes("\\");
  const separator = slash && !back ? "/" : !slash && back ? "\\" : sep;
  const norm = (value) => (separator === "\\" ? value.toLowerCase() : value);
  const p = norm(parent);
  const c = norm(child);
  if (p === c) return true;
  const prefix = p.endsWith(separator) ? p : p + separator;
  return c.startsWith(prefix);
}

/** True for `/`, `C:\`, and `\\server\share` (the root of any filesystem). */
export function isRootPath(path) {
  const parsed = parse(path);
  if (parsed.root === path || (parsed.dir === parsed.root && parsed.base === "")) return true;
  // Lexical fallback so drive-root probes (`C:\`, `C:/`) are recognized even
  // on a posix platform where path.parse does not model drive letters.
  return /^[A-Za-z]:[\\/]$/.test(path);
}

/** The deepest existing ancestor of `path`, or `null` when none exists. */
function deepestExistingAncestor(path) {
  let current = path;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Validate `input` against `cwd` and return the absolute path to remove.
 * Throws a fixed, sanitized message for every unsafe form; on success the
 * returned path is guaranteed to sit inside the real cwd.
 */
export function resolveTarget(cwd, input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("empty path");
  }
  if (input.includes("\0")) {
    throw new Error("path contains a NUL byte");
  }
  if (input.trim() === "") {
    throw new Error("whitespace-only path");
  }
  // Drive and UNC probes are classified before the generic absolute check.
  // On win32 `C:\` and `C:\foo` are absolute, so the generic message would
  // hide that a drive root (or a path off one) was the reason for refusal.
  if (DRIVE_PATH.test(input)) {
    // A bare drive root is both a drive path and a filesystem root.
    const kind = DRIVE_ROOT.test(input) ? "absolute drive path / root path" : "absolute drive path";
    throw new Error(`${kind} ${JSON.stringify(input)} is outside the working directory`);
  }
  if (UNC_ROOT.test(input)) {
    throw new Error(`UNC root ${JSON.stringify(input)} is outside the working directory`);
  }
  // Relative-only contract: an absolute path is rejected even when it happens
  // to point beneath cwd, so callers cannot bypass the cwd-relative intent.
  if (isAbsolute(input)) {
    throw new Error(`absolute path ${JSON.stringify(input)} is not allowed; pass a path relative to the working directory`);
  }
  const resolved = resolve(cwd, input);
  if (isRootPath(resolved)) {
    throw new Error(`root path ${JSON.stringify(input)} may not be removed`);
  }
  const cwdReal = realpathSync(cwd);

  let resolvedStat = null;
  try {
    resolvedStat = lstatSync(resolved);
  } catch {
    // Does not exist yet (e.g. a clean target); the ancestor check below
    // still confines it, and force removal is a no-op.
  }

  // A top-level symlink is removed as a link (its target survives), so it is
  // safe to delete the link itself.
  if (resolvedStat && resolvedStat.isSymbolicLink()) return resolved;

  // The working directory itself must never be removed. Compare realpaths so
  // aliased prefixes (macOS /var -> /private/var) are caught.
  if (resolvedStat && eq(realpathSync(resolved), cwdReal)) {
    throw new Error(`refusing to remove the working directory itself (${JSON.stringify(input)})`);
  }

  // Parent / symlink-escape guard: the deepest existing ancestor's realpath
  // must stay inside the real cwd. A path that reaches THROUGH an escaping
  // symlink component would delete outside cwd, so it is rejected.
  const ancestor = deepestExistingAncestor(resolved);
  if (ancestor === null) {
    throw new Error(`cannot resolve ${JSON.stringify(input)} from ${cwd}`);
  }
  const ancestorReal = realpathSync(ancestor);
  if (!isWithin(cwdReal, ancestorReal)) {
    throw new Error(`path ${JSON.stringify(input)} resolves outside the working directory`);
  }
  return resolved;
}

/** Remove validated targets; resolves with the process exit code. */
export function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length === 0) {
    console.error("usage: node scripts/remove-paths.mjs <path> [path...]");
    return 2;
  }
  const cwd = options.cwd ?? process.cwd();
  const rmImpl = options.rmImpl ?? rmSync;

  // Validate every target up front; any unsafe path refuses the whole run.
  const rejections = [];
  const targets = [];
  for (const input of argv) {
    try {
      targets.push(resolveTarget(cwd, input));
    } catch (err) {
      rejections.push(`${input}: ${err.message}`);
    }
  }
  if (rejections.length > 0) {
    for (const rejection of rejections) console.error(`[pix] refused to remove ${rejection}`);
    return 2;
  }

  let failed = false;
  for (const target of targets) {
    try {
      rmImpl(target, { recursive: true, force: true, ...RETRY });
    } catch (err) {
      failed = true;
      console.error(`[pix] failed to remove ${target}: ${err.message}`);
    }
  }
  return failed ? 1 : 0;
}

// Run only when executed directly. Compare canonical paths so symlinked
// prefixes such as /var -> /private/var on macOS still match.
if (process.argv[1]) {
  try {
    const isMain =
      realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
    if (isMain) process.exitCode = main();
  } catch {
    // Not the main module.
  }
}
