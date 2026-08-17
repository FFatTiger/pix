import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeWindowsAce {
  type: "allow" | "deny" | "other";
  sid: string;
  mask: number;
  flags: number;
  inherited: boolean;
}

export interface NativeWindowsPathInspection {
  volumeSerial: string;
  fileId: string;
  size: string;
  attributes: number;
  reparseTag: number;
  isReparsePoint: boolean;
  isDirectory: boolean;
  isFile: boolean;
  ownerSid: string;
  daclPresent: boolean;
  daclProtected: boolean;
  aces: NativeWindowsAce[];
}

export type NativeWindowsPrivateKind = "file" | "directory";

export interface NativeWindowsBinding {
  readonly apiVersion: 2;
  currentUserSid(): string;
  inspectPath(path: string): NativeWindowsPathInspection | null;
  createPrivateObject(path: string, kind: NativeWindowsPrivateKind): boolean;
}

function assertInspectablePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    const error = new Error("path is invalid") as Error & { code?: string };
    error.code = "NATIVE_INVALID_ARGUMENT";
    throw error;
  }
}

function assertPrivateKind(kind: string): asserts kind is NativeWindowsPrivateKind {
  if (kind !== "file" && kind !== "directory") {
    const error = new Error("kind is invalid") as Error & { code?: string };
    error.code = "NATIVE_INVALID_ARGUMENT";
    throw error;
  }
}

let cached: NativeWindowsBinding | undefined;

function isBinding(value: unknown): value is NativeWindowsBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NativeWindowsBinding>;
  return candidate.apiVersion === 2
    && typeof candidate.currentUserSid === "function"
    && typeof candidate.inspectPath === "function"
    && typeof candidate.createPrivateObject === "function";
}

/** Load the target-native addon without exposing it from the package surface. */
export function loadNativeWindowsBinding(): NativeWindowsBinding {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows native binding is unavailable for this target");
  }
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const bindingPath = join(here, "..", "native", "win32-x64-msvc", "pix_local_authority_windows.node");
  const require = createRequire(import.meta.url);
  let loaded: unknown;
  try {
    loaded = require(bindingPath);
  } catch {
    throw new Error("Windows native binding could not be loaded");
  }
  if (!isBinding(loaded)) throw new Error("Windows native binding contract mismatch");
  cached = {
    apiVersion: 2,
    currentUserSid: () => loaded.currentUserSid(),
    inspectPath: (path) => {
      assertInspectablePath(path);
      return loaded.inspectPath(path);
    },
    createPrivateObject: (path, kind) => {
      assertInspectablePath(path);
      assertPrivateKind(kind);
      return loaded.createPrivateObject(path, kind);
    },
  };
  return cached;
}
