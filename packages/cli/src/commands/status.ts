import { inspectSessiond } from "../supervise.js";
import { pixLog } from "../log.js";

/**
 * `pix status` — report sessiond lifecycle state: not running / stale lock /
 * running, with pid, instance id, endpoint and directory. When a live pid is
 * found, reachability is confirmed by a real RPC ping (not pid-aliveness alone).
 */
export async function statusCommand(): Promise<number> {
  const status = await inspectSessiond();
  if (status.obstructed) {
    // A live listener without a lock, an unsafe lock, or a live-but-unreachable
    // pid is an authoritative obstacle, never "not running" — report it
    // honestly and exit non-zero so scripts do not treat the directory as down.
    pixLog("sessiond: obstructed");
    pixLog(`  reason: ${status.obstruction ?? "sessiond state is unsafe"}`);
    pixLog(`  directory: ${status.directory}`);
    return 1;
  }
  if (status.pid === undefined) {
    pixLog("sessiond: not running");
  } else if (!status.alive) {
    pixLog("sessiond: not running (stale lock)");
    pixLog(`  pid: ${status.pid}  instance: ${status.instanceId ?? "?"}`);
  } else {
    pixLog(`sessiond: running (${status.pingable ? "healthy" : "locked but unreachable"})`);
    pixLog(`  pid: ${status.pid}  instance: ${status.instanceId ?? "?"}`);
    pixLog(`  endpoint: ${status.endpoint}`);
  }
  pixLog(`  directory: ${status.directory}`);
  return 0;
}
