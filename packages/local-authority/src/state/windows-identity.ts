import {
  LocalAuthorityError,
  type WindowsFileIdentity,
  type WindowsPrincipal,
} from "./contracts.js";
import { loadNativeWindowsBinding } from "./native-windows.js";

const SID_SHAPE = /^S-1-[0-9-]+$/u;
const FILE_ID_SHAPE = /^[0-9a-f]{32}$/u;
const VOLUME_SERIAL_SHAPE = /^[0-9]+$/u;

function requireWindowsBinding() {
  try {
    return loadNativeWindowsBinding();
  } catch {
    throw new LocalAuthorityError(
      "UNSUPPORTED_PLATFORM",
      "Native Windows secure state is unavailable",
    );
  }
}

function requireSid(value: string, code: "UNSAFE_COMPONENT" | "UNSUPPORTED_PLATFORM"): string {
  if (!SID_SHAPE.test(value)) {
    throw new LocalAuthorityError(code, "Windows security identity is unavailable");
  }
  return value;
}

/** Current process user SID. Binding or SID-shape failure is fail-closed. */
export function currentWindowsPrincipal(): WindowsPrincipal {
  const sid = requireSid(requireWindowsBinding().currentUserSid(), "UNSUPPORTED_PLATFORM");
  return { kind: "windows", sid };
}

/**
 * Handle-based Windows identity. Missing paths return null. Reparse points are
 * still identities — callers decide whether a given operation may accept them.
 */
function requireInspectablePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
  }
}

export async function windowsFileIdentity(path: string): Promise<WindowsFileIdentity | null> {
  requireInspectablePath(path);
  const binding = requireWindowsBinding();
  let inspection;
  try {
    inspection = binding.inspectPath(path);
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component cannot be inspected");
  }
  if (!inspection) return null;
  if (!VOLUME_SERIAL_SHAPE.test(inspection.volumeSerial) || !FILE_ID_SHAPE.test(inspection.fileId)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path identity could not be inspected");
  }
  if (!/^[0-9]+$/u.test(inspection.size)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path identity could not be inspected");
  }
  return {
    kind: "windows",
    volumeSerial: inspection.volumeSerial,
    fileId: inspection.fileId,
    size: inspection.size,
    ownerSid: requireSid(inspection.ownerSid, "UNSAFE_COMPONENT"),
    isFile: inspection.isFile,
    isDirectory: inspection.isDirectory,
    isReparsePoint: inspection.isReparsePoint,
  };
}

export function inspectWindowsOwnerSid(path: string): string | null {
  requireInspectablePath(path);
  const binding = requireWindowsBinding();
  let inspection;
  try {
    inspection = binding.inspectPath(path);
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path security could not be inspected");
  }
  if (!inspection) return null;
  return requireSid(inspection.ownerSid, "UNSAFE_COMPONENT");
}

export function isWindowsOwnedByCurrentUser(ownerSid: string, principal = currentWindowsPrincipal()): boolean {
  return ownerSid === principal.sid;
}
