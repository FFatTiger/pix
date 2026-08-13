import { parseBindArgs, type BindOptions } from "../args.js";
import { inspectSessiond, locateSessiond } from "../supervise.js";
import { runHost } from "./host-runner.js";
import { pixLog, pixErr } from "../log.js";

/**
 * `pix-host` / `pix host` — boot the Host only. Requires an already-running,
 * pingable sessiond; it never spawns one, so it is the right entry for a
 * supervised restart of the web layer while sessions stay alive.
 */
export async function hostCommand(argv: string[]): Promise<number> {
  let options: BindOptions;
  try {
    options = parseBindArgs(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  const status = await inspectSessiond();
  if (!status.pingable) {
    pixErr(
      status.alive
        ? `sessiond locked (pid ${status.pid}) but not reachable at ${status.endpoint}`
        : "no reachable sessiond; start one with `pix start` or `pix sessiond`",
    );
    return 1;
  }
  pixLog(`sessiond reachable (pid ${status.pid}); starting host`);
  const located = locateSessiond();
  const location = status.endpoint === located.endpoint
    ? located
    : {
        ...located,
        endpoint: status.endpoint,
        paths: { ...located.paths, endpoint: status.endpoint },
      };
  return runHost(location, options);
}
