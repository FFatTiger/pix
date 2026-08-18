import type { HostPathFlavor } from "@fffattiger/pix-protocol/host-bootstrap";

/**
 * Host-authoritative path grammar from a canonical workspace path.
 * UNC wins over drive-absolute. Unknown / empty shapes stay posix so the
 * Client never invents windows case-folding.
 */
export function resolveHostPathFlavor(canonicalPath: string | undefined): HostPathFlavor {
  if (typeof canonicalPath !== "string" || canonicalPath === "") return "posix";
  const normalized = canonicalPath.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) return "windows-unc";
  if (/^[A-Za-z]:[\\/]/.test(canonicalPath) || /^[A-Za-z]:\\/.test(normalized)) return "windows-drive";
  return "posix";
}
