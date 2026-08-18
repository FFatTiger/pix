const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\/?$/;

export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

/** Keep `C:/` as a drive root instead of collapsing it to `C:`. */
export function keepWindowsDriveRoot(normalized: string): string {
  return WINDOWS_DRIVE_ROOT.test(normalized)
    ? `${normalized[0]!.toUpperCase()}:/`
    : normalized.replace(/\/+$/, "");
}

function isWindowsDriveAbsolute(normalized: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE.test(normalized) || WINDOWS_DRIVE_ROOT.test(normalized);
}

function compareForm(normalized: string): string {
  return isWindowsDriveAbsolute(normalized) ? normalized.toLowerCase() : normalized;
}

/** Comparison key for Git/status maps. Drive-absolute paths fold case; `C:/` stays a root. */
export function filePathCompareKey(filePath: string): string {
  return compareForm(keepWindowsDriveRoot(normalizeFilePathSlashes(filePath)));
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = keepWindowsDriveRoot(normalizeFilePathSlashes(cwd));
  const fileCmp = compareForm(normalizedFile);
  const cwdCmp = compareForm(normalizedCwd);
  if (fileCmp === cwdCmp || fileCmp === `${cwdCmp}/`) return ".";
  const prefix = cwdCmp.endsWith("/") ? cwdCmp : `${cwdCmp}/`;
  if (fileCmp.startsWith(prefix)) {
    return normalizedFile.slice(normalizedCwd.length + (normalizedCwd.endsWith("/") ? 0 : 1));
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}
