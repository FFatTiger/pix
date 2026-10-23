import { parseFlags } from "../args.js";
import { defaultHostDaemonDeps, stopHostBackground, type HostDaemonDeps } from "../host-daemon.js";
import { shutdownSessiond } from "../supervise.js";
import { pixLog, pixErr } from "../log.js";

/**
 * Stop the background Host; with `all`, also stop sessiond through its
 * authenticated shutdown RPC (never a PID signal). Returns the exit code.
 */
export async function stopServices(all: boolean, deps: HostDaemonDeps = defaultHostDaemonDeps()): Promise<number> {
  const host = await stopHostBackground(deps);
  let code = 0;
  if (host.action === "not-running") {
    pixLog("host: no background host");
  } else if (host.action === "stopped") {
    pixLog(`host: stopped (pid ${host.pid}${host.forced ? ", forced after timeout" : ""})`);
  } else if (host.action === "refused") {
    pixErr(`host: ${host.reason}`);
    code = 1;
  } else {
    pixErr(`host: failed to stop (pid ${host.pid}): ${host.reason}`);
    code = 1;
  }
  if (!all) {
    if (code === 0) pixLog("sessiond keeps running (sessions survive); `pix stop --all` also stops it");
    return code;
  }
  const sessiond = await shutdownSessiond();
  if (sessiond.action === "already-down") {
    pixLog("sessiond: already down");
  } else if (sessiond.action === "terminated") {
    pixLog(`sessiond: terminated (pid ${sessiond.pid})`);
  } else if (sessiond.action === "obstructed") {
    pixErr(`sessiond: refusing to stop (obstructed): ${sessiond.reason}`);
    code = 1;
  } else {
    pixErr(`sessiond: failed to stop (pid ${sessiond.pid}): ${sessiond.reason}`);
    code = 1;
  }
  return code;
}

/**
 * `pix stop [--all]` — stop the background Host started by `pix start --detach`.
 * Sessions keep running in sessiond unless `--all` is given.
 */
export async function stopCommand(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseFlags(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  if (parsed.positional.length > 0 || [...parsed.boolFlags].some((flag) => flag !== "--all") || parsed.flags.size > 0) {
    pixErr("usage: pix stop [--all]");
    return 2;
  }
  return stopServices(parsed.boolFlags.has("--all"));
}
