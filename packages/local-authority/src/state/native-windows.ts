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

export interface NativeWindowsNamedPipeInspection {
  ownerSid: string;
  daclPresent: boolean;
  daclProtected: boolean;
  aces: NativeWindowsAce[];
}

export interface NativeWindowsProcessInspection {
  creationTime: string;
}

export interface NativeWindowsBinding {
  readonly apiVersion: 7;
  currentUserSid(): string;
  inspectPath(path: string): NativeWindowsPathInspection | null;
  createPrivateObject(path: string, kind: NativeWindowsPrivateKind): boolean;
  /** CREATE_NEW + write + flush on the same handle; never publishes a zero-byte final. */
  createExclusivePrivateFile(path: string, bytes: Buffer): boolean;
  inspectNamedPipe(path: string): NativeWindowsNamedPipeInspection | null;
  createProtectedNamedPipe(path: string): bigint;
  inspectNamedPipeHandle(handle: bigint): NativeWindowsNamedPipeInspection | null;
  closeNamedPipeHandle(handle: bigint): boolean;
  readNamedPipeHandle(handle: bigint, maxBytes: number): Promise<Buffer>;
  writeNamedPipeHandle(handle: bigint, bytes: Buffer): Promise<number>;
  listenProtectedNamedPipe(path: string, onHandle: (handle: bigint) => void): bigint;
  inspectProtectedNamedPipeListener(handle: bigint): NativeWindowsNamedPipeInspection | null;
  closeProtectedNamedPipeListener(handle: bigint): boolean;
  protectNamedPipe(path: string): boolean;
  inspectProcess(pid: number): NativeWindowsProcessInspection | null;
}

function assertInspectablePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    const error = new Error("path is invalid") as Error & { code?: string };
    error.code = "NATIVE_INVALID_ARGUMENT";
    throw error;
  }
}

function assertHandle(handle: bigint): void {
  if (typeof handle !== "bigint" || handle <= 0n) {
    const error = new Error("handle is invalid") as Error & { code?: string };
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
  return candidate.apiVersion === 7
    && typeof candidate.currentUserSid === "function"
    && typeof candidate.inspectPath === "function"
    && typeof candidate.createPrivateObject === "function"
    && typeof candidate.createExclusivePrivateFile === "function"
    && typeof candidate.inspectNamedPipe === "function"
    && typeof candidate.createProtectedNamedPipe === "function"
    && typeof candidate.inspectNamedPipeHandle === "function"
    && typeof candidate.closeNamedPipeHandle === "function"
    && typeof candidate.readNamedPipeHandle === "function"
    && typeof candidate.writeNamedPipeHandle === "function"
    && typeof candidate.listenProtectedNamedPipe === "function"
    && typeof candidate.inspectProtectedNamedPipeListener === "function"
    && typeof candidate.closeProtectedNamedPipeListener === "function"
    && typeof candidate.protectNamedPipe === "function"
    && typeof candidate.inspectProcess === "function";
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
    apiVersion: 7,
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
    createExclusivePrivateFile: (path, bytes) => {
      assertInspectablePath(path);
      if (!Buffer.isBuffer(bytes) || bytes.length > 65536) {
        const error = new Error("bytes are invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.createExclusivePrivateFile(path, bytes);
    },
    inspectNamedPipe: (path) => {
      assertInspectablePath(path);
      return loaded.inspectNamedPipe(path);
    },
    createProtectedNamedPipe: (path) => {
      assertInspectablePath(path);
      return loaded.createProtectedNamedPipe(path);
    },
    inspectNamedPipeHandle: (handle) => {
      if (typeof handle !== "bigint" || handle <= 0n) {
        const error = new Error("handle is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.inspectNamedPipeHandle(handle);
    },
    closeNamedPipeHandle: (handle) => {
      if (typeof handle !== "bigint" || handle <= 0n) {
        const error = new Error("handle is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.closeNamedPipeHandle(handle);
    },
    readNamedPipeHandle: (handle, maxBytes) => {
      assertHandle(handle);
      if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 65536) {
        const error = new Error("maxBytes is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.readNamedPipeHandle(handle, maxBytes);
    },
    writeNamedPipeHandle: (handle, bytes) => {
      assertHandle(handle);
      if (!Buffer.isBuffer(bytes)) {
        const error = new Error("bytes are invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.writeNamedPipeHandle(handle, bytes);
    },
    listenProtectedNamedPipe: (path, onHandle) => {
      assertInspectablePath(path);
      if (typeof onHandle !== "function") {
        const error = new Error("callback is required") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.listenProtectedNamedPipe(path, (raw) => {
        if (typeof raw !== "bigint" || raw <= 0n) return;
        onHandle(raw);
      });
    },
    inspectProtectedNamedPipeListener: (handle) => {
      if (typeof handle !== "bigint" || handle <= 0n) {
        const error = new Error("handle is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.inspectProtectedNamedPipeListener(handle);
    },
    closeProtectedNamedPipeListener: (handle) => {
      if (typeof handle !== "bigint" || handle <= 0n) {
        const error = new Error("handle is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.closeProtectedNamedPipeListener(handle);
    },
    protectNamedPipe: (path) => {
      assertInspectablePath(path);
      return loaded.protectNamedPipe(path);
    },
    inspectProcess: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        const error = new Error("pid is invalid") as Error & { code?: string };
        error.code = "NATIVE_INVALID_ARGUMENT";
        throw error;
      }
      return loaded.inspectProcess(pid);
    },
  };
  return cached;
}
