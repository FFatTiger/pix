import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureStateBackend } from "@fffattiger/pix-local-authority/state";

/**
 * Create a sessiond runtime directory through the production secure-state
 * backend. A Windows `mkdtemp` directory carries inherited ACLs and is
 * intentionally rejected when used directly as existing sensitive state;
 * creating a new `runtime` leaf beneath it gives the backend ownership of the
 * leaf DACL without weakening that production policy.
 */
export interface PrivateRuntimeDirectory {
  readonly directory: string;
  cleanup(): Promise<void>;
}

export async function createPrivateRuntimeDirectory(prefix: string): Promise<PrivateRuntimeDirectory> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  try {
    const directory = join(parent, "runtime");
    await createSecureStateBackend().ensurePrivateDirectory(directory, { requireMode: 0o700 });
    return {
      directory,
      cleanup: () => rm(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}
