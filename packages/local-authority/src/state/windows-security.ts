import { LocalAuthorityError, type WindowsPrincipal } from "./contracts.js";
import type { NativeWindowsAce, NativeWindowsPathInspection } from "./native-windows.js";
import { currentWindowsPrincipal } from "./windows-identity.js";

const SID_SHAPE = /^S-1-[0-9-]+$/u;
/** Local SYSTEM. Frozen allowlist subject, never Administrators. */
export const WINDOWS_LOCAL_SYSTEM_SID = "S-1-5-18";
/** Builtin Administrators. Presence is always fail-closed. */
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const GENERIC_ALL = 0x10000000;
const FILE_ALL_ACCESS = 0x001f01ff;

function hasFullControl(mask: number): boolean {
  return (mask & GENERIC_ALL) === GENERIC_ALL || (mask & FILE_ALL_ACCESS) === FILE_ALL_ACCESS;
}

function sameSid(left: string, right: string): boolean {
  return left.toUpperCase() === right.toUpperCase();
}

function isAllowlistedSid(sid: string, principal: WindowsPrincipal): boolean {
  return sameSid(sid, principal.sid) || sameSid(sid, WINDOWS_LOCAL_SYSTEM_SID);
}

/**
 * Fail-closed classification of native path security evidence.
 *
 * Frozen private-state DACL policy:
 * - owner SID = current process user
 * - DACL present and protected (no inheritance)
 * - allowlist is current user + SYSTEM only
 * - Administrators or any other SID is NOT_PRIVATE
 * - inherited or deny ACEs are NOT_PRIVATE
 * - each allow ACE must grant full control
 *
 * Existing wide ACLs are never repaired here.
 */
export function rejectUnsafeWindowsSecurityEvidence(
  inspection: NativeWindowsPathInspection,
  principal: WindowsPrincipal = currentWindowsPrincipal(),
): void {
  if (inspection.isReparsePoint) {
    throw new LocalAuthorityError("SYMLINK", "Canonical path must not contain a symbolic link");
  }
  if (!SID_SHAPE.test(inspection.ownerSid)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path security could not be inspected");
  }
  if (!sameSid(inspection.ownerSid, principal.sid)) {
    throw new LocalAuthorityError("NOT_OWNED", "Directory is owned by another user");
  }
  if (!inspection.daclPresent || !inspection.daclProtected || !Array.isArray(inspection.aces)) {
    throw new LocalAuthorityError("NOT_PRIVATE", "Directory mode must be private");
  }

  let sawOwner = false;
  let sawSystem = false;
  for (const ace of inspection.aces) {
    if (!isReportedAce(ace)) {
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path security could not be inspected");
    }
    if (ace.inherited || ace.type !== "allow" || !hasFullControl(ace.mask)) {
      throw new LocalAuthorityError("NOT_PRIVATE", "Directory mode must be private");
    }
    if (sameSid(ace.sid, WINDOWS_ADMINISTRATORS_SID) || !isAllowlistedSid(ace.sid, principal)) {
      throw new LocalAuthorityError("NOT_PRIVATE", "Directory mode must be private");
    }
    if (sameSid(ace.sid, principal.sid)) sawOwner = true;
    if (sameSid(ace.sid, WINDOWS_LOCAL_SYSTEM_SID)) sawSystem = true;
  }
  if (!sawOwner || !sawSystem) {
    throw new LocalAuthorityError("NOT_PRIVATE", "Directory mode must be private");
  }
}

function isReportedAce(value: NativeWindowsAce): value is NativeWindowsAce {
  return (value.type === "allow" || value.type === "deny" || value.type === "other")
    && SID_SHAPE.test(value.sid)
    && Number.isInteger(value.mask)
    && Number.isInteger(value.flags)
    && typeof value.inherited === "boolean";
}

/** True only when evidence is well-formed enough to continue fail-closed checks. */
export function hasUsableWindowsSecurityEvidence(inspection: NativeWindowsPathInspection): boolean {
  return SID_SHAPE.test(inspection.ownerSid)
    && typeof inspection.daclPresent === "boolean"
    && typeof inspection.daclProtected === "boolean"
    && Array.isArray(inspection.aces);
}
