import { win32 as pathWin32 } from "node:path";
import { hasControlChar, LocalAuthorityError } from "./contracts.js";
import { loadNativeWindowsBinding, type NativeWindowsBinding } from "./native-windows.js";

const MAX_CANONICAL_PATH_LENGTH = 4096;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/;
const UNC_OR_DEVICE = /^(\\\\|\/\/)/;
const EXTENDED = /^(\\\\\?\\|\/\/\?\/|\\\\\.\\|\/\/\.\/)/i;
const RESERVED_DOS_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function requireWindowsBinding(): NativeWindowsBinding {
  try {
    return loadNativeWindowsBinding();
  } catch {
    throw new LocalAuthorityError(
      "UNSUPPORTED_PLATFORM",
      "Native Windows secure state is unavailable",
    );
  }
}

function isReservedDosName(segment: string): boolean {
  return RESERVED_DOS_NAME.test(segment);
}

function inspectOrThrow(binding: NativeWindowsBinding, path: string) {
  try {
    return binding.inspectPath(path);
  } catch {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component cannot be inspected");
  }
}

/**
 * Pure shape predicate for a Windows drive-absolute path. Drive roots such as
 * `C:\` are valid shapes; UNC, extended, relative, and `.` / `..` forms are not.
 * Operational canonicalize still rejects the filesystem root.
 */
export function isWindowsDriveAbsoluteShape(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CANONICAL_PATH_LENGTH
    || value.includes("\0")
  ) {
    return false;
  }
  if (!DRIVE_ABSOLUTE.test(value) || UNC_OR_DEVICE.test(value) || EXTENDED.test(value)) {
    return false;
  }
  if (DRIVE_ROOT.test(value)) return true;
  if (/[\\/]$/.test(value)) return false;
  const segments = value.slice(3).split(/[\\/]/u);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || isReservedDosName(segment)) {
      return false;
    }
  }
  return true;
}

function lexicalWindowsSegments(path: string): string[] {
  const afterDrive = path.slice(2);
  const raw = afterDrive.split(/[\\/]/u);
  if (raw.length === 0 || raw[0] !== "") {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }
  const segments = raw.slice(1);
  // `C:\` / `C:/` is a lone trailing empty segment and names the drive root.
  if (segments.length === 1 && segments[0] === "") return [];
  if (segments.length > 0 && segments[segments.length - 1] === "") {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new LocalAuthorityError("PARENT_ESCAPE", "Path must not contain parent or current directory components");
    }
    if (segment === "" || segment.includes("\0") || isReservedDosName(segment)) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component is unsafe");
    }
  }
  return segments;
}

function joinDrive(driveLetter: string, segments: readonly string[]): string {
  const drive = `${driveLetter.toUpperCase()}:\\`;
  return segments.length === 0 ? drive : `${drive}${segments.join("\\")}`;
}

function existingSegmentsOf(path: string): string[] {
  return DRIVE_ROOT.test(path) ? [] : path.slice(3).split("\\").filter((segment) => segment.length > 0);
}

/**
 * Canonicalize a Windows drive-absolute path without following reparse points.
 *
 * Existing components are inspected through the private native binding with
 * `FILE_FLAG_OPEN_REPARSE_POINT`. A reparse intermediate or leaf is fail-closed
 * as `SYMLINK`. UNC, `\\?\`, `\\.`, drive-relative, and `.`/`..` forms are
 * rejected before any filesystem mutation. This helper never creates paths.
 */
export async function canonicalizeWindowsAbsolutePath(path: string): Promise<string> {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > MAX_CANONICAL_PATH_LENGTH
    || path.includes("\0")
    || hasControlChar(path)
  ) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }
  if (EXTENDED.test(path) || UNC_OR_DEVICE.test(path)) {
    throw new LocalAuthorityError("NETWORK_PATH", "Network share paths are not supported");
  }
  if (!DRIVE_ABSOLUTE.test(path)) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }

  const segments = lexicalWindowsSegments(path);
  if (segments.length === 0) {
    throw new LocalAuthorityError("ROOT_PATH", "Filesystem root is not a valid canonical target");
  }
  const driveLetter = path[0]!;
  const normalized = joinDrive(driveLetter, segments);
  const binding = requireWindowsBinding();

  let existing = normalized;
  const missing: string[] = [];
  for (;;) {
    const inspection = inspectOrThrow(binding, existing);
    if (inspection) {
      if (inspection.isReparsePoint) {
        throw new LocalAuthorityError("SYMLINK", "Canonical path must not contain a symbolic link");
      }
      break;
    }
    const parent = pathWin32.dirname(existing);
    if (parent === existing) {
      throw new LocalAuthorityError("ROOT_PATH", "Path has no existing ancestor");
    }
    missing.unshift(pathWin32.basename(existing));
    if (DRIVE_ROOT.test(parent)) {
      const rootInspection = inspectOrThrow(binding, parent);
      if (!rootInspection || rootInspection.isReparsePoint || !rootInspection.isDirectory) {
        throw new LocalAuthorityError("ROOT_PATH", "Path has no existing ancestor");
      }
      existing = parent;
      break;
    }
    existing = parent;
  }

  let walked: string[] = [];
  for (const segment of existingSegmentsOf(existing)) {
    walked = [...walked, segment];
    const current = joinDrive(driveLetter, walked);
    const info = inspectOrThrow(binding, current);
    if (!info) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Canonical path component cannot be inspected");
    }
    if (info.isReparsePoint) {
      throw new LocalAuthorityError("SYMLINK", "Canonical path must not contain a symbolic link");
    }
    if (!info.isDirectory) {
      throw new LocalAuthorityError("NOT_DIRECTORY", "Canonical path must be a directory");
    }
  }

  return missing.length === 0 ? existing : pathWin32.join(existing, ...missing);
}
