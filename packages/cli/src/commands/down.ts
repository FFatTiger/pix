import { parseFlags } from "../args.js";
import { shutdownSessiond } from "../supervise.js";
import { pixLog, pixErr } from "../log.js";

/**
 * `pix down` — stop the sessiond daemon. The explicit `--all` guard prevents an
 * accidental `pix down` from killing the authoritative session authority while
 * sessions may still be running. Idempotent: an already-down daemon is a no-op.
 */
export async function downCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  if (!parsed.boolFlags.has("--all")) {
    pixErr("refusing to stop sessiond without --all");
    pixErr("usage: pix down --all");
    return 2;
  }
  const result = await shutdownSessiond();
  if (result.action === "already-down") {
    pixLog("sessiond: already down");
  } else if (result.action === "obstructed") {
    // An unsafe lock, a live listener without a lock, or a live-but-unreachable
    // pid is not "already down": report the obstruction and refuse to touch it.
    pixErr(`sessiond: refusing to stop (obstructed): ${result.reason}`);
    return 1;
  } else if (result.action === "terminated") {
    pixLog(`sessiond: terminated (pid ${result.pid})`);
  } else {
    // Sanitized reason only (never the secret/endpoint/instance id/stack); the
    // target process is left untouched.
    pixErr(`sessiond: failed to stop (pid ${result.pid}): ${result.reason}`);
    return 1;
  }
  return 0;
}
