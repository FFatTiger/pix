import { createSecureStateBackend } from "@fffattiger/pix-local-authority/state";

export interface SecureStateBackendInspection {
  kind: "windows" | "posix" | "unavailable";
}

/** Read-only factory probe. Never walks a path and never prints secrets. */
export function inspectSecureStateBackend(): SecureStateBackendInspection {
  try {
    const backend = createSecureStateBackend();
    return { kind: backend.kind };
  } catch {
    return { kind: "unavailable" };
  }
}
