import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, win32 as pathWin32 } from "node:path";
import {
  isRecord,
  isSafeInteger,
  isValidInstanceId,
  LocalAuthorityError,
  type AcquireLifetimeLockOptions,
  type EnsurePrivateDirectoryOptions,
  type EnsurePrivateDirectoryResult,
  type LifetimeLockReadResult,
  type ReadStateDocumentOptions,
  type ReleaseLifetimeLockOptions,
  type StateDocumentReadResult,
  type WindowsFileIdentity,
  type WindowsLifetimeLockOwnership,
  type WindowsPrincipal,
  type WindowsSecureStateBackend,
  type WriteStateDocumentOptions,
} from "./contracts.js";
import { loadNativeWindowsBinding, type NativeWindowsBinding } from "./native-windows.js";
import {
  currentWindowsPrincipal,
  windowsFileIdentity,
} from "./windows-identity.js";
import { canonicalizeWindowsAbsolutePath } from "./windows-path.js";
import { rejectUnsafeWindowsSecurityEvidence } from "./windows-security.js";

const DRIVE_ROOT = /^[A-Z]:\\$/;

function requireBinding(): NativeWindowsBinding {
  try {
    return loadNativeWindowsBinding();
  } catch {
    throw new LocalAuthorityError(
      "UNSUPPORTED_PLATFORM",
      "Native Windows secure state is unavailable",
    );
  }
}

function inspectOrThrow(binding: NativeWindowsBinding, path: string) {
  try {
    return binding.inspectPath(path);
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    const code = (error as { code?: string }).code;
    if (code === "NATIVE_INVALID_ARGUMENT") {
      throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
    }
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path component cannot be inspected");
  }
}

function requireWindowsIdentity(inspection: NonNullable<ReturnType<NativeWindowsBinding["inspectPath"]>>): WindowsFileIdentity {
  if (!/^[0-9]+$/u.test(inspection.size) || !/^[0-9a-f]{32}$/u.test(inspection.fileId) || !/^[0-9]+$/u.test(inspection.volumeSerial)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path identity could not be inspected");
  }
  if (!/^S-1-[0-9-]+$/u.test(inspection.ownerSid)) {
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path security could not be inspected");
  }
  return {
    kind: "windows",
    volumeSerial: inspection.volumeSerial,
    fileId: inspection.fileId,
    size: inspection.size,
    ownerSid: inspection.ownerSid,
    isFile: inspection.isFile,
    isDirectory: inspection.isDirectory,
    isReparsePoint: inspection.isReparsePoint,
  };
}

function sameWindowsIdentity(left: Pick<WindowsFileIdentity, "volumeSerial" | "fileId">, right: Pick<WindowsFileIdentity, "volumeSerial" | "fileId">): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function requirePrivateDirectory(
  inspection: NonNullable<ReturnType<NativeWindowsBinding["inspectPath"]>>,
  principal: WindowsPrincipal,
): WindowsFileIdentity {
  if (inspection.isReparsePoint) {
    throw new LocalAuthorityError("SYMLINK", "Directory path is unsafe");
  }
  if (!inspection.isDirectory) {
    throw new LocalAuthorityError("NOT_DIRECTORY", "Directory path is unsafe");
  }
  rejectUnsafeWindowsSecurityEvidence(inspection, principal);
  return requireWindowsIdentity(inspection);
}

function requirePrivateRegularFile(
  inspection: NonNullable<ReturnType<NativeWindowsBinding["inspectPath"]>>,
  principal: WindowsPrincipal,
  oversizeCode: "DOC_OVERSIZE",
  maxBytes?: number,
): WindowsFileIdentity {
  if (inspection.isReparsePoint) {
    throw new LocalAuthorityError("DOC_SYMLINK", "State document must not be a symbolic link");
  }
  if (!inspection.isFile) {
    throw new LocalAuthorityError("NOT_REGULAR", "State document must be a regular file");
  }
  rejectUnsafeWindowsSecurityEvidence(inspection, principal);
  if (maxBytes !== undefined) {
    try {
      const size = BigInt(inspection.size);
      if (size > BigInt(maxBytes)) {
        throw new LocalAuthorityError(oversizeCode, "State document exceeds the size bound");
      }
    } catch (error) {
      if (error instanceof LocalAuthorityError) throw error;
      throw new LocalAuthorityError("UNSAFE_COMPONENT", "Path identity could not be inspected");
    }
  }
  const identity = requireWindowsIdentity(inspection);
  if (!identity.isFile || identity.isDirectory || identity.isReparsePoint) {
    throw new LocalAuthorityError("NOT_REGULAR", "State document must be a regular file");
  }
  return identity;
}

class NativeAlreadyExistsError extends Error {
  readonly code = "NATIVE_ALREADY_EXISTS";
}

function createPrivate(binding: NativeWindowsBinding, path: string, kind: "file" | "directory"): void {
  try {
    binding.createPrivateObject(path, kind);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "NATIVE_ALREADY_EXISTS") {
      throw new NativeAlreadyExistsError("path already exists");
    }
    if (code === "NATIVE_INVALID_ARGUMENT") {
      throw new LocalAuthorityError("INVALID_PATH", "Path must be a bounded absolute path without control characters");
    }
    throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  }
}

export async function ensureWindowsPrivateDirectory(
  path: string,
  options: EnsurePrivateDirectoryOptions = {},
): Promise<EnsurePrivateDirectoryResult> {
  const canonical = await canonicalizeWindowsAbsolutePath(path);
  const binding = requireBinding();
  const principal = currentWindowsPrincipal();
  const segments = DRIVE_ROOT.test(canonical)
    ? []
    : canonical.slice(3).split("\\").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new LocalAuthorityError("ROOT_PATH", "Directory must not be the filesystem root");
  }

  let current = `${canonical.slice(0, 2)}\\`;
  let creating = false;
  let leafCreated = false;
  for (const segment of segments) {
    current = pathWin32.join(current, segment);
    const isLeaf = current === canonical;
    const inspection = inspectOrThrow(binding, current);
    if (!creating && inspection) {
      if (inspection.isReparsePoint) {
        throw new LocalAuthorityError("SYMLINK", "Directory path is unsafe");
      }
      if (!inspection.isDirectory) {
        throw new LocalAuthorityError("NOT_DIRECTORY", "Directory path is unsafe");
      }
      continue;
    }
    if (!inspection) {
      creating = true;
      createPrivate(binding, current, "directory");
      const created = inspectOrThrow(binding, current);
      if (!created) throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
      requirePrivateDirectory(created, principal);
      if (isLeaf) leafCreated = true;
      continue;
    }
    if (inspection.isReparsePoint) {
      throw new LocalAuthorityError("SYMLINK", "Directory path is unsafe");
    }
    if (!inspection.isDirectory) {
      throw new LocalAuthorityError("NOT_DIRECTORY", "Directory path is unsafe");
    }
    requirePrivateDirectory(inspection, principal);
  }

  const finalInspection = inspectOrThrow(binding, current);
  if (!finalInspection) throw new LocalAuthorityError("UNSAFE_COMPONENT", "Directory path is unsafe");
  const identity = requirePrivateDirectory(finalInspection, principal);
  if (!leafCreated && options.validateExistingLeaf) {
    await options.validateExistingLeaf({ identity, path: current });
  }
  return { path: current, created: leafCreated, identity };
}

export async function readWindowsStateDocument(
  path: string,
  options: ReadStateDocumentOptions,
): Promise<StateDocumentReadResult> {
  const binding = requireBinding();
  const principal = currentWindowsPrincipal();
  const before = inspectOrThrow(binding, path);
  if (!before) return { missing: true };
  const identity = requirePrivateRegularFile(before, principal, "DOC_OVERSIZE", options.maxBytes);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new LocalAuthorityError("DOC_UNREADABLE", "State document is unreadable");
  }
  const after = inspectOrThrow(binding, path);
  if (!after) throw new LocalAuthorityError("DOC_UNREADABLE", "State document is unreadable");
  const afterIdentity = requirePrivateRegularFile(after, principal, "DOC_OVERSIZE", options.maxBytes);
  if (!sameWindowsIdentity(identity, afterIdentity)) {
    throw new LocalAuthorityError("DOC_UNREADABLE", "State document is unreadable");
  }
  return { content: text };
}

const WINDOWS_DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP", "EISDIR"]);

async function flushDirectory(dirPath: string, failDirFsync?: () => void): Promise<void> {
  try {
    failDirFsync?.();
    const handle = await open(dirPath, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && WINDOWS_DIR_FSYNC_UNSUPPORTED_CODES.has(code)) {
      return;
    }
    throw new LocalAuthorityError("DIR_FSYNC_FAILED", "Directory fsync failed");
  }
}

export async function writeWindowsStateDocument(
  path: string,
  payload: string,
  options: WriteStateDocumentOptions,
): Promise<void> {
  if (Buffer.byteLength(payload, "utf8") > options.maxBytes) {
    throw new LocalAuthorityError("DOC_OVERSIZE", "Serialized state document exceeds size bound");
  }
  const binding = requireBinding();
  const principal = currentWindowsPrincipal();
  const existing = inspectOrThrow(binding, path);
  if (existing) requirePrivateRegularFile(existing, principal, "DOC_OVERSIZE");
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    createPrivate(binding, temp, "file");
    const handle = await open(temp, constants.O_WRONLY);
    let tempIdentity: WindowsFileIdentity;
    try {
      await handle.writeFile(payload, "utf8");
      options.inject?.failTempFsync?.();
      await handle.sync();
    } finally {
      await handle.close();
    }
    const tempInspection = inspectOrThrow(binding, temp);
    if (!tempInspection) throw new LocalAuthorityError("WRITE_FAILED", "Atomic state document write failed");
    tempIdentity = requirePrivateRegularFile(tempInspection, principal, "DOC_OVERSIZE");
    if (options.lockCheck) {
      if (options.lockCheck.ownership.kind !== "windows") {
        throw new LocalAuthorityError("LOCK_LOST", "Lifetime lock ownership lost before publish");
      }
      const lockInspection = inspectOrThrow(binding, options.lockCheck.path);
      if (
        !lockInspection
        || lockInspection.isReparsePoint
        || !lockInspection.isFile
        || lockInspection.volumeSerial !== options.lockCheck.ownership.volumeSerial
        || lockInspection.fileId !== options.lockCheck.ownership.fileId
      ) {
        throw new LocalAuthorityError("LOCK_LOST", "Lifetime lock ownership lost before publish");
      }
    }
    options.inject?.failRename?.();
    await rename(temp, path);
    const published = inspectOrThrow(binding, path);
    if (!published || !sameWindowsIdentity(tempIdentity, requirePrivateRegularFile(published, principal, "DOC_OVERSIZE"))) {
      throw new LocalAuthorityError("WRITE_FAILED", "Published state document identity mismatch");
    }
    await flushDirectory(dirname(path), options.inject?.failDirFsync);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if (error instanceof LocalAuthorityError) throw error;
    throw new LocalAuthorityError("WRITE_FAILED", "Atomic state document write failed");
  }
}

function readLockRecord(text: string): { pid: number; instanceId: string; createdAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!isValidInstanceId(parsed.instanceId)) return null;
  if (!isSafeInteger(parsed.createdAt)) return null;
  return {
    pid: parsed.pid,
    instanceId: parsed.instanceId,
    createdAt: parsed.createdAt,
  };
}

export function isWindowsPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readWindowsLifetimeLock(path: string): Promise<LifetimeLockReadResult> {
  const binding = requireBinding();
  const principal = currentWindowsPrincipal();
  const inspection = inspectOrThrow(binding, path);
  if (!inspection) return { kind: "missing" };
  try {
    requirePrivateRegularFile(inspection, principal, "DOC_OVERSIZE");
  } catch {
    return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  }
  const after = inspectOrThrow(binding, path);
  if (!after || after.volumeSerial !== inspection.volumeSerial || after.fileId !== inspection.fileId) {
    return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  }
  const record = readLockRecord(text);
  if (record === null) return { kind: "unsafe", reason: "LOCK_UNSAFE" };
  return {
    kind: "valid",
    record,
    identity: { kind: "windows", volumeSerial: inspection.volumeSerial, fileId: inspection.fileId },
  };
}

async function classifyExistingLock(
  path: string,
  isPidAlive: (pid: number) => boolean,
): Promise<never> {
  const existing = await readWindowsLifetimeLock(path);
  if (existing.kind === "unsafe") {
    throw new LocalAuthorityError("LOCK_UNSAFE", "Existing lifetime lock is unsafe");
  }
  if (existing.kind === "missing") {
    throw new LocalAuthorityError("LOCK_AMBIGUOUS", "Lifetime lock identity is ambiguous");
  }
  let alive = false;
  try {
    alive = isPidAlive(existing.record.pid);
  } catch {
    throw new LocalAuthorityError("LOCK_UNSAFE", "Existing lifetime lock could not be classified");
  }
  if (alive) {
    throw new LocalAuthorityError("LOCK_BUSY", "Another process holds the lifetime lock");
  }
  throw new LocalAuthorityError(
    "LOCK_STALE",
    "Lifetime lock is stale; verify the old process is dead and remove the lock explicitly",
  );
}

export async function acquireWindowsLifetimeLock(
  path: string,
  options: AcquireLifetimeLockOptions,
): Promise<WindowsLifetimeLockOwnership> {
  const binding = requireBinding();
  const principal = currentWindowsPrincipal();
  try {
    createPrivate(binding, path, "file");
    const handle = await open(path, constants.O_WRONLY);
    try {
      await handle.writeFile(options.payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const inspection = inspectOrThrow(binding, path);
    if (!inspection) {
      throw new LocalAuthorityError("LOCK_UNSAFE", "Lifetime lock ownership could not be pinned");
    }
    const identity = requirePrivateRegularFile(inspection, principal, "DOC_OVERSIZE");
    return { kind: "windows", volumeSerial: identity.volumeSerial, fileId: identity.fileId };
  } catch (error) {
    if (error instanceof LocalAuthorityError) throw error;
    if (error instanceof NativeAlreadyExistsError) {
      return classifyExistingLock(path, options.isPidAlive);
    }
    throw new LocalAuthorityError("LOCK_UNSAFE", "Could not create lifetime lock");
  }
}

export async function releaseWindowsLifetimeLock(
  path: string,
  options: ReleaseLifetimeLockOptions,
): Promise<void> {
  if (options.ownership.kind !== "windows") return;
  const current = await readWindowsLifetimeLock(path);
  if (current.kind !== "valid") return;
  if (current.record.instanceId !== options.instanceId) return;
  if (
    current.identity.kind !== "windows"
    || current.identity.volumeSerial !== options.ownership.volumeSerial
    || current.identity.fileId !== options.ownership.fileId
  ) {
    return;
  }
  await rm(path, { force: true }).catch(() => {});
}

export function createWindowsSecureStateBackend(): WindowsSecureStateBackend {
  return {
    kind: "windows",
    canonicalizePath: (path) => canonicalizeWindowsAbsolutePath(path),
    fileIdentity: (path) => windowsFileIdentity(path),
    principal: () => currentWindowsPrincipal(),
    isOwnedByCurrentUser: (identity) => identity.kind === "windows" && identity.ownerSid === currentWindowsPrincipal().sid,
    ensurePrivateDirectory: (path, opts) => ensureWindowsPrivateDirectory(path, opts),
    readStateDocument: (path, opts) => readWindowsStateDocument(path, opts),
    writeStateDocument: (path, payload, opts) => writeWindowsStateDocument(path, payload, opts),
    acquireLifetimeLock: (path, opts) => acquireWindowsLifetimeLock(path, opts),
    readLifetimeLock: (path) => readWindowsLifetimeLock(path),
    releaseLifetimeLock: (path, opts) => releaseWindowsLifetimeLock(path, opts),
    isPidAlive: (pid) => isWindowsPidAlive(pid),
  };
}

