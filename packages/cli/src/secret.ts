import { lstat, readFile } from "node:fs/promises";

/**
 * Minimum trimmed length of an accepted sessiond secret. The daemon publishes a
 * base64url encoding of 32 random bytes (43 chars); requiring >= 32 rejects
 * debris/partial files while staying compatible with the publisher.
 */
export const MIN_SECRET_LENGTH = 32;

export class UnsafeSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSecretError";
  }
}

/**
 * Read the sessiond local secret in a strictly read-only, fail-closed way.
 *
 * Guarantees (B4 supervision contract):
 *   - Never creates, writes, or chmods the file. The daemon owns publication.
 *   - Rejects symlinks and non-regular files via `lstat` (no follow).
 *   - Requires the trimmed secret to be at least {@link MIN_SECRET_LENGTH}
 *     chars, so a 0-byte or partial file cannot be used as a credential.
 *
 * Returns `undefined` when the file does not exist yet (the daemon has not
 * published it); throws {@link UnsafeSecretError} for an unsafe/existing-but-
 * malformed file. Network callers must treat `undefined` as "not ready".
 */
export async function readLocalSecret(secretFile: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(secretFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new UnsafeSecretError(`unsafe sessiond secret file (not a regular file): ${secretFile}`);
  }
  let raw: string;
  try {
    raw = await readFile(secretFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const secret = raw.trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new UnsafeSecretError(`sessiond secret too short (${secret.length} < ${MIN_SECRET_LENGTH}): ${secretFile}`);
  }
  return secret;
}
