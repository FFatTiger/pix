// Helpers that turn dropped-file absolute paths into cwd-relative @ mention
// tokens. Pure string logic so it runs in the browser (no node:path).

import { keepWindowsDriveRoot, normalizeFilePathSlashes } from "./file-paths";

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/** Forward slashes; keep a Windows drive root as `C:/`. */
export function normalizePathSlashes(p: string): string {
  return keepWindowsDriveRoot(normalizeFilePathSlashes(p));
}

function isWindowsDrivePath(p: string): boolean {
  return WINDOWS_DRIVE_RE.test(p);
}

/** Lowercased comparison key — Windows paths are case-insensitive. */
function pathCompareKey(p: string): string {
  return isWindowsDrivePath(p) ? p.toLowerCase() : p;
}

export interface CwdRelativeResult {
  /** cwd-relative "/"-separated paths, no leading "./" */
  mentions: string[];
  /** Absolute paths that fall outside cwd and cannot be referenced */
  rejected: string[];
}

/**
 * Convert absolute dropped-file paths into cwd-relative @ mention paths.
 * A path is accepted only when it lives under cwd; anything else (including
 * `..` escapes and case-variant drive roots) is rejected so the @ token keeps
 * its "project file" semantics.
 */
export function toCwdRelativeMentions(absPaths: string[], cwd: string): CwdRelativeResult {
  const mentions: string[] = [];
  const rejected: string[] = [];
  const normalizedCwd = normalizePathSlashes(cwd);
  if (!normalizedCwd) return { mentions, rejected: [...absPaths] };
  const cwdKey = pathCompareKey(normalizedCwd);
  const cwdPrefix = cwdKey.endsWith("/") ? cwdKey : `${cwdKey}/`;

  for (const raw of absPaths) {
    const normalized = normalizePathSlashes(raw);
    if (!normalized || pathCompareKey(normalized) === cwdKey) {
      rejected.push(raw);
      continue;
    }
    const key = pathCompareKey(normalized);
    if (!key.startsWith(cwdPrefix)) {
      rejected.push(raw);
      continue;
    }
    const relative = normalized.slice(normalizedCwd.length + (normalizedCwd.endsWith("/") ? 0 : 1));
    if (!relative || relative.startsWith("../")) {
      rejected.push(raw);
      continue;
    }
    mentions.push(relative);
  }
  return { mentions, rejected };
}
