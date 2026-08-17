import type { BigIntStats } from "node:fs";
import { lstat, readFile, rm } from "node:fs/promises";
import { SessiondError } from "../errors.js";

/** Minimum secret entropy before base64url encoding. */
export const SESSIOND_SECRET_MIN_BYTES = 32;
/** Bounded existing secret document size (base64url payload + one newline). */
export const SESSIOND_SECRET_MAX_BYTES = 1024;

export interface ExistingSecretPath {
  readonly secretFile: string;
}

export interface ExistingSecretReadHooks {
  beforeSecretRead?: () => void | Promise<void>;
  beforeZeroByteRemoval?: () => void | Promise<void>;
}

/**
 * Validate security metadata before an existing sessiond secret is read.
 * This pure internal helper is exported only from its direct internal module so
 * deterministic tests can supply forged ownership evidence; it is not part of
 * the package root/control surface.
 */
export function validateExistingSecretInfo(info: BigIntStats): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SessiondError("forbidden", "unsafe sessiond secret file");
  }
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (currentUid !== undefined && info.uid !== currentUid) {
    throw new SessiondError("forbidden", "unsafe sessiond secret file ownership");
  }
  if ((info.mode & 0o777n) !== 0o600n) {
    throw new SessiondError("forbidden", "unsafe sessiond secret file permissions");
  }
  if (info.nlink !== 1n) {
    throw new SessiondError("forbidden", "unsafe sessiond secret file link count");
  }
  if (info.size > BigInt(SESSIOND_SECRET_MAX_BYTES)) {
    throw new SessiondError("forbidden", "sessiond secret file exceeds the size bound");
  }
}

/**
 * Read and validate an existing secret with identity pinning. This internal
 * primitive is deliberately absent from the package root/control exports.
 */
export async function readExistingSecret(
  paths: ExistingSecretPath,
  hooks: ExistingSecretReadHooks = {},
): Promise<string | undefined> {
  const info = await lstat(paths.secretFile, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new SessiondError("forbidden", "sessiond secret file could not be inspected");
  });
  if (info === undefined) return undefined;
  validateExistingSecretInfo(info);
  if (info.size === 0n) {
    await hooks.beforeZeroByteRemoval?.();
    const beforeRemove = await lstat(paths.secretFile, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new SessiondError("forbidden", "sessiond secret file could not be inspected");
    });
    if (beforeRemove === undefined) return undefined;
    if (
      beforeRemove.isSymbolicLink()
      || !beforeRemove.isFile()
      || beforeRemove.dev !== info.dev
      || beforeRemove.ino !== info.ino
    ) {
      return undefined;
    }
    await rm(paths.secretFile, { force: true });
    return undefined;
  }

  await hooks.beforeSecretRead?.();
  let text: string;
  try {
    text = await readFile(paths.secretFile, "utf8");
  } catch {
    throw new SessiondError("forbidden", "sessiond secret file is unreadable");
  }
  const after = await lstat(paths.secretFile, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new SessiondError("forbidden", "sessiond secret file could not be inspected");
  });
  if (
    after === undefined
    || after.isSymbolicLink()
    || !after.isFile()
    || after.dev !== info.dev
    || after.ino !== info.ino
  ) {
    throw new SessiondError("forbidden", "sessiond secret file identity changed during read");
  }
  const secret = text.trim();
  if (secret.length < SESSIOND_SECRET_MIN_BYTES) {
    throw new SessiondError("internal", "invalid sessiond secret");
  }
  return secret;
}
