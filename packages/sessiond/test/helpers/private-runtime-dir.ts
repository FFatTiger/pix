import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureStateBackend } from "@fffattiger/pix-local-authority/state";

/**
 * Create a sessiond runtime directory through the production secure-state
 * backend. A Windows `mkdtemp` directory carries inherited ACLs and is
 * intentionally rejected when used directly as existing sensitive state;
 * creating a new `runtime` leaf beneath it gives the backend ownership of the
 * leaf DACL without weakening that production policy.
 *
 * POSIX: `os.tmpdir()` is often a system alias (`/tmp` → `/private/tmp`,
 * `/var/folders` → `/private/var/folders`). VS Code just binds under that
 * short path; pix's walk fail-closes any symlink component, so tests must
 * mkdtemp under `realpath(tmpdir())` and walk the canonical leaf — the same
 * operational/canonical split `startDaemon` already uses.
 */
export interface PrivateRuntimeDirectory {
  readonly directory: string;
  cleanup(): Promise<void>;
}

export async function createPrivateRuntimeDirectory(prefix: string): Promise<PrivateRuntimeDirectory> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), prefix));
  try {
    const directory = join(parent, "runtime");
    const backend = createSecureStateBackend();
    const canonical = await backend.canonicalizePath(directory);
    await backend.ensurePrivateDirectory(canonical, { requireMode: 0o700 });
    return {
      directory,
      cleanup: () => rm(parent, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}
