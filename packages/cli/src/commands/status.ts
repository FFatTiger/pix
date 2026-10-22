import { inspectSessiond } from "../supervise.js";
import { defaultHostDaemonDeps, inspectHost, type HostDaemonDeps } from "../host-daemon.js";
import { pixLog } from "../log.js";

/**
 * `pix status` — report sessiond lifecycle state (not running / stale lock /
 * running, with pid, instance id, endpoint and directory; reachability is a
 * real RPC ping, not pid-aliveness alone) and the background Host started by
 * `pix start` (pid, URL, log). Exit 1 when either is obstructed / unhealthy in
 * a way scripts must not read as "down".
 */
export async function statusCommand(deps: HostDaemonDeps = defaultHostDaemonDeps()): Promise<number> {
  let code = 0;
  const status = await inspectSessiond();
  if (status.obstructed) {
    // A live listener without a lock, an unsafe lock, or a live-but-unreachable
    // pid is an authoritative obstacle, never "not running" — report it
    // honestly and exit non-zero so scripts do not treat the directory as down.
    pixLog("sessiond: obstructed");
    pixLog(`  reason: ${status.obstruction ?? "sessiond state is unsafe"}`);
    code = 1;
  } else if (status.pid === undefined) {
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

  const host = await inspectHost(deps);
  switch (host.kind) {
    case "not-running":
    case "stale":
      // A foreground `pix start --foreground` / `pix host` keeps no record.
      pixLog("host: stopped (no background host)");
      break;
    case "running":
      pixLog("host: running (healthy)");
      break;
    case "unresponsive":
      pixLog("host: running but not responding");
      code = 1;
      break;
    case "unverified":
      pixLog(`host: unknown (${host.reason}; recorded pid ${host.record.pid})`);
      code = 1;
      break;
    case "corrupt":
      pixLog(`host: unknown (unreadable record ${host.path})`);
      code = 1;
      break;
  }
  if (host.kind === "running" || host.kind === "unresponsive") {
    pixLog(`  pid: ${host.record.pid}  url: ${host.record.url}`);
    pixLog(`  logs: ${host.record.logFile}`);
  }
  return code;
}
