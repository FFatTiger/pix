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
  } else if (result.action === "terminated") {
    pixLog(`sessiond: terminated (pid ${result.pid})`);
  } else {
    pixErr(`sessiond: failed to stop (pid ${result.pid}, ${result.reason}); process may be stuck`);
    return 1;
  }
  return 0;
}
